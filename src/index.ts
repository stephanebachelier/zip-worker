/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `wrangler dev src/index.ts` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `wrangler publish src/index.ts --name my-worker` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

export interface Env {
  MONGODB_API_ENDPOINT: string;
  MONGODB_API_SECRET: string;
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

const buildSearchString = (search: SearchQuery):string =>
  Object.keys(search)
    .map((key:string) => (`${key}=${encodeURIComponent(search[key] as string)}`))
    .join('&')


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

    const remoteUrl = `${env.MONGODB_API_ENDPOINT}?${buildSearchString(searchQuery)}`
    console.log(remoteUrl)

    const cache = caches.default;
    let cachedResponse = await cache.match(remoteUrl);

    console.log(`cache hit : ${cachedResponse !== undefined}`)

    if (!cachedResponse) {
      cachedResponse = await fetch(remoteUrl.toString(), {
        headers: {
          'content-type': 'application/json;charset=UTF-8',
          'api-key': env.MONGODB_API_SECRET
        },
        cf: {
          // cacheTtl: env.CACHE_TTL,
          cacheEverything: true,
          cacheTtlByStatus: {
            '200-299': cacheTtl,
            '404': 1,
            '500-599': 0
          }
        }
      });

      console.log(cachedResponse.status)
      console.log(cachedResponse.statusText)

      ctx.waitUntil(cache.put(remoteUrl, cachedResponse.clone()));
    }

    return buildResultsResponse(await processResults(cachedResponse), origin, cacheTtl);
  },
};
