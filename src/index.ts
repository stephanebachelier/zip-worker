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

const buildResponse = function (status: number, message: string, contentType = 'text/plain'): Response {
  return new Response(message, {
    status,
    headers: {
      'content-type': contentType
    }
  })
}

const buildResultsResponse = function (results: Array<SearchResult>):Response {
  return buildResponse(200, JSON.stringify({ results }), 'application/json')
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
    return response.json()
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

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    if (request.method !== 'GET') {
      return buildResponse(405, 'Method Not Allowed')
    }

    const url = new URL(request.url)
    const params = url.searchParams
    console.log(params)

    try {
      if (detectEdgeCases(params) === null) {
        return buildResultsResponse([])
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

    console.log(searchQuery)

    const remoteUrl = `${env.MONGODB_API_ENDPOINT}?${buildSearchString(searchQuery)}`
    console.log(remoteUrl)
    const init = {
      headers: {
        'content-type': 'application/json;charset=UTF-8',
        'api-key': env.MONGODB_API_SECRET
      },
    };
    const response = await fetch(remoteUrl.toString(), init);

    console.log(response.status)
    console.log(response.statusText)
    console.log(response.headers)
    return buildResultsResponse(await processResults(response));
  },
};
