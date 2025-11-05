/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `wrangler dev src/index.ts` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `wrangler publish src/index.ts --name my-worker` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */
import { MongoClient } from 'mongodb';
export interface Env {
  MONGODB_URI: string;
  DOMAIN: string;
  CACHE_TTL: string;
}

type AutoCompleteFlag = 0 | 1

type SearchQuery = Record<string, unknown> & {
  search: string
  autocomplete: AutoCompleteFlag
}

type SearchResult = {
  zip: string
  name: string
}

type Origin = string | null

const buildResponse = (status: number, message: string | null, headers?: Record<string, string> | null): Response => {
  console.log('buildResponse', headers)
  return new Response(message, {
    status,
    headers: headers ?? {
      'content-type': 'text/plain'
    }
  })
}

/**
 * @name buildResultsResponse
 * @desc |
 *   Need to inject origin as the client code does not send an preflight request due to a search
 *   using a GET request.
 * @param results
 * @param origin
 * @returns Response
 */
const buildResultsResponse = (results: Array<SearchResult>, origin: Origin, cacheTtl:number):Response => {
  const headers = {
    'content-type': 'application/json',
    'cache-control': `public, maxage=${cacheTtl}, immutable`,
    ...(origin ? setCorsHeaders(origin) : {})
  }
  return buildResponse(200, JSON.stringify({ results }), headers)
}

const processResults = async (response: Response): Promise<Array<SearchResult>> => {
  if (!response) {
    throw new Error('Unexpected function call') 
  }

  try {
    const results:Array<SearchResult> = (await response.json()) || []
    console.log(`Found ${results.length} entries`)
    return results
  } catch (e) {
    throw new Error('Invalid response')
  }
}

const detectEdgeCases = (params: URLSearchParams): null | undefined => {
  const query = params.get('query')
  const search = params.get('search')

  if (!query && !search) {
    throw new Error('Bad Request')
  }

  if (query && search) {
    throw new Error('Bad Request')
  }

  const entry:string = (query?.length ? query : search) as string

  if (entry.length < 3) {
    return null
  }
}

const setCorsHeaders = (origin: string) => ({
  'access-control-allow-origin': origin,
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-max-age': '86400',
})

const hasValidOrigin = (request: Request, env:Env):Boolean => {
  console.log('hasValidOrigin', request.headers.get('origin'), env.DOMAIN)
  return request.headers.get('origin') === env.DOMAIN
}

function handleOptions(request:Request, env:Env) {
  let headers = request.headers;

  if (hasValidOrigin(request, env)) {
    // Handle CORS pre-flight request.
    return new Response(null, {
      headers: setCorsHeaders(env.DOMAIN)
    });
  } else {
    // Handle standard OPTIONS request.
    return new Response(null, {
      headers: setCorsHeaders(env.DOMAIN)
    });
  }
}

/**
 * Search for zip codes in MongoDB
 * @param searchTerm - The city name to search for
 * @param isAutocomplete - Whether this is an autocomplete query
 * @param mongoUri - MongoDB connection string
 * @returns Array of search results
 */
async function searchZipCodes(
  searchTerm: string,
  isAutocomplete: boolean,
  mongoUri: string
): Promise<Array<SearchResult>> {
  const client = new MongoClient(mongoUri);

  try {
    await client.connect();
    const db = client.db('zip');
    const collection = db.collection('zip');

    // Build the query - case insensitive regex search on name field
    const query = {
      name: { $regex: searchTerm, $options: 'i' }
    };

    // For autocomplete, we might want to limit results more aggressively
    const limit = isAutocomplete ? 10 : 50;

    const results = await collection
      .find(query)
      .project({ _id: 0, name: 1, zip: 1 }) // Only return name and zip fields
      .limit(limit)
      .toArray();

    return results as Array<SearchResult>;
  } catch (error) {
    console.error('MongoDB query error:', error);
    throw new Error('Database query failed');
  } finally {
    await client.close();
  }
}

/**
 * Generate a cache key based on search parameters
 */
function getCacheKey(searchQuery: SearchQuery): string {
  // return `zip-search:${searchQuery.search}:${searchQuery.autocomplete}`;
  return `zip-search:${searchQuery.search}`;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return handleOptions(request, env)
    }

    if (!['GET', 'HEAD'].includes(request.method)) {
      return buildResponse(405, 'Method Not Allowed')
    }

    const url = new URL(request.url)
    const params = url.searchParams

    const origin: Origin = hasValidOrigin(request, env) ? env.DOMAIN : null

    if (request.method === 'HEAD') {
      return buildResponse(200, null, setCorsHeaders(env.DOMAIN))
    }

    const cacheTtlValue = parseInt(env.CACHE_TTL, 10)
    // use default if invalid cache TTL
    const cacheTtl = isNaN(cacheTtlValue) ? 300 : cacheTtlValue

    try {
      if (detectEdgeCases(params) === null) {
        return buildResultsResponse([], origin, cacheTtl)
      }
    } catch (e) {
      return buildResponse(400, 'Bad Request') 
    }

    const query = params.get('query')
    const search = params.get('search')

    const searchQuery: SearchQuery = {
      search: (query ?? search) as string,
      autocomplete: query !== null ? 1 : 0
    }

    // Create a cache key for this search
    const cacheKey = new Request(
      `https://cache.internal/${getCacheKey(searchQuery)}`,
      request
    );

    const cache = caches.default;
    let cachedResponse = await cache.match(cacheKey);

    console.log(`cache hit : ${cachedResponse !== undefined}`)

    if (!cachedResponse) {
      try {
        const results = await searchZipCodes(
          searchQuery.search,
          searchQuery.autocomplete === 1,
          env.MONGODB_URI
        );

        console.log(`Found ${results.length} entries`)

        // Build the response
        const response = buildResultsResponse(results, origin, cacheTtl);

        // Store in cache for future requests
        ctx.waitUntil(cache.put(cacheKey, response.clone()));

        return response;
      } catch (error) {
        console.error('Search error:', error);
        return buildResponse(500, 'Internal Server Error');
      }
    }

    return buildResultsResponse(await processResults(cachedResponse), origin, cacheTtl);
  },
};
