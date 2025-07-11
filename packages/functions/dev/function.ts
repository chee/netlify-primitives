import { basename, extname } from 'node:path'
import { version as nodeVersion } from 'node:process'

import { EnvironmentContext } from '@netlify/blobs'
import { headers as netlifyHeaders, MemoizeCache, renderFunctionErrorPage } from '@netlify/dev-utils'
import type { ExtendedRoute, FunctionResult, Route } from '@netlify/zip-it-and-ship-it'
import CronParser from 'cron-parser'
import semver from 'semver'

import { BuildResult } from './builder.js'
import { Runtime } from './runtimes/index.js'
import { HandlerContext } from '../src/main.js'

export type FunctionBuildCache = MemoizeCache<FunctionResult>

const BACKGROUND_FUNCTION_SUFFIX = '-background'
const TYPESCRIPT_EXTENSIONS = new Set(['.cts', '.mts', '.ts'])
const V2_MIN_NODE_VERSION = '18.14.0'

// Returns a new set with all elements of `setA` that don't exist in `setB`.
const difference = (setA: Set<string>, setB: Set<string>) => new Set([...setA].filter((item) => !setB.has(item)))

const getNextRun = function (schedule: string) {
  const cron = CronParser.parseExpression(schedule, {
    tz: 'Etc/UTC',
  })
  return cron.next().toDate()
}

export interface InvocationError {
  errorMessage: string
  errorType: string
  stackTrace: string[]
}

export const getBlobsEventProperty = (context: EnvironmentContext) => ({
  primary_region: context.primaryRegion,
  url: context.edgeURL,
  url_uncached: context.edgeURL,
  token: context.token,
})

interface NetlifyFunctionOptions {
  blobsContext?: EnvironmentContext
  config: any
  directory: string
  displayName?: string
  excludedRoutes?: Route[]
  mainFile: string
  name: string
  projectRoot: string
  routes?: ExtendedRoute[]
  runtime: Runtime
  settings: any
  timeoutBackground: number
  timeoutSynchronous: number
}

interface InvokeFunctionOptions {
  buildCache?: FunctionBuildCache
  buildDirectory?: string
  clientContext?: HandlerContext['clientContext']
  request: Request
  route?: string
}

export class NetlifyFunction {
  public name: string
  public mainFile: string
  public displayName: string
  public schedule?: string
  public runtime: Runtime

  private readonly blobsContext?: EnvironmentContext
  private readonly config: any
  private readonly directory: string
  private readonly projectRoot: string
  private readonly settings: any
  private readonly timeoutBackground: number
  private readonly timeoutSynchronous: number

  // Determines whether this is a background function based on the function
  // name.
  public readonly isBackground: boolean

  private buildQueue?: Promise<BuildResult | undefined>
  private buildData?: BuildResult
  public buildError: Error | null = null

  // List of the function's source files. This starts out as an empty set
  // and will get populated on every build.
  private srcFiles = new Set<string>()

  public excludedRoutes: Route[] | undefined
  public routes: ExtendedRoute[] | undefined

  constructor({
    blobsContext,
    config,
    directory,
    displayName,
    excludedRoutes,
    mainFile,
    name,
    projectRoot,
    routes,
    runtime,
    settings,
    timeoutBackground,
    timeoutSynchronous,
  }: NetlifyFunctionOptions) {
    this.blobsContext = blobsContext
    this.config = config
    this.directory = directory
    this.excludedRoutes = excludedRoutes
    this.mainFile = mainFile
    this.name = name
    this.displayName = displayName ?? name
    this.projectRoot = projectRoot
    this.routes = routes
    this.runtime = runtime
    this.timeoutBackground = timeoutBackground
    this.timeoutSynchronous = timeoutSynchronous
    this.settings = settings

    this.isBackground = name.endsWith(BACKGROUND_FUNCTION_SUFFIX)

    const functionConfig = config.functions?.[name]
    this.schedule = functionConfig?.schedule

    this.srcFiles = new Set()
  }

  get filename() {
    if (!this.buildData?.mainFile) {
      return null
    }

    return basename(this.buildData.mainFile)
  }

  getRecommendedExtension() {
    if (this.buildData?.runtimeAPIVersion !== 2) {
      return
    }

    const extension = this.buildData?.mainFile ? extname(this.buildData.mainFile) : undefined
    const moduleFormat = this.buildData?.outputModuleFormat

    if (moduleFormat === 'esm') {
      return
    }

    if (extension === '.ts') {
      return '.mts'
    }

    if (extension === '.js') {
      return '.mjs'
    }
  }

  hasValidName() {
    // same as https://github.com/netlify/bitballoon/blob/fbd7881e6c8e8c48e7a0145da4ee26090c794108/app/models/deploy.rb#L482
    return /^[A-Za-z0-9_-]+$/.test(this.name)
  }

  async isScheduled() {
    await this.buildQueue

    return Boolean(this.schedule)
  }

  isSupported() {
    return !(this.buildData?.runtimeAPIVersion === 2 && semver.lt(nodeVersion, V2_MIN_NODE_VERSION))
  }

  isTypeScript() {
    if (this.filename === null) {
      return false
    }

    return TYPESCRIPT_EXTENSIONS.has(extname(this.filename))
  }

  async getNextRun() {
    if (!(await this.isScheduled())) {
      return null
    }

    return getNextRun(this.schedule!)
  }

  // The `build` method transforms source files into invocable functions. Its
  // return value is an object with:
  //
  // - `srcFilesDiff`: Files that were added and removed since the last time
  //    the function was built.
  async build({ buildDirectory, cache }: { buildDirectory: string; cache: MemoizeCache<FunctionResult> }) {
    this.buildQueue = this.runtime
      .getBuildFunction({
        config: this.config,
        directory: this.directory,
        func: this,
        projectRoot: this.projectRoot,
        targetDirectory: buildDirectory,
      })
      .then((buildFunction) => buildFunction({ cache }))

    try {
      const buildData = await this.buildQueue

      if (buildData === undefined) {
        throw new Error(`Could not build function ${this.name}`)
      }

      const { includedFiles = [], routes, schedule, srcFiles } = buildData
      const srcFilesSet = new Set<string>(srcFiles)
      const srcFilesDiff = this.getSrcFilesDiff(srcFilesSet)

      this.buildData = buildData
      this.buildError = null
      this.routes = routes

      this.srcFiles = srcFilesSet
      this.schedule = schedule || this.schedule

      if (!this.isSupported()) {
        throw new Error(
          `Function requires Node.js version ${V2_MIN_NODE_VERSION} or above, but ${nodeVersion.slice(
            1,
          )} is installed. Refer to https://ntl.fyi/functions-runtime for information on how to update.`,
        )
      }

      return { includedFiles, srcFilesDiff }
    } catch (error) {
      if (error instanceof Error) {
        this.buildError = error
      }

      return { error }
    }
  }

  private formatError(rawError: Error | InvocationError, acceptsHTML: boolean): string {
    const error = this.normalizeError(rawError)

    if (acceptsHTML) {
      return JSON.stringify({
        ...error,
        stackTrace: undefined,
        trace: error.stackTrace,
      })
    }

    return `${error.errorType}: ${error.errorMessage}\n ${error.stackTrace.join('\n')}`
  }

  async getBuildData() {
    await this.buildQueue

    return this.buildData
  }

  // Compares a new set of source files against a previous one, returning an
  // object with two Sets, one with added and the other with deleted files.
  getSrcFilesDiff(newSrcFiles: Set<string>) {
    const added = difference(newSrcFiles, this.srcFiles)
    const deleted = difference(this.srcFiles, newSrcFiles)

    return {
      added,
      deleted,
    }
  }

  private async handleError(rawError: Error | InvocationError | string, acceptsHTML: boolean): Promise<Response> {
    const errorString = typeof rawError === 'string' ? rawError : this.formatError(rawError, acceptsHTML)
    const status = 500

    if (acceptsHTML) {
      const body = await renderFunctionErrorPage(errorString, 'function')

      return new Response(body, {
        headers: {
          'Content-Type': 'text/html',
        },
        status,
      })
    }

    return new Response(errorString, { status })
  }

  // Invokes the function and returns its response object.
  async invoke({ buildCache = {}, buildDirectory, clientContext = {}, request, route }: InvokeFunctionOptions) {
    // If a `buildDirectory` has been supplied, it means we need to run a build
    // specifically for this invocation. Otherwise, we use the build queue.
    if (buildDirectory) {
      await this.build({ buildDirectory, cache: buildCache })
    } else {
      await this.buildQueue
    }

    if (this.buildError) {
      throw this.buildError
    }

    const timeout = this.isBackground ? this.timeoutBackground : this.timeoutSynchronous
    const environment = {}

    if (this.blobsContext) {
      const payload = JSON.stringify(getBlobsEventProperty(this.blobsContext))

      request.headers.set(netlifyHeaders.BlobsInfo, Buffer.from(payload).toString('base64'))
    }

    try {
      return await this.runtime.invokeFunction({
        context: clientContext,
        environment,
        func: this,
        request,
        route,
        timeout,
      })
    } catch (error) {
      const acceptsHTML = request.headers.get('accept')?.includes('text/html')

      return await this.handleError(error as Error | InvocationError | string, Boolean(acceptsHTML))
    }
  }

  /**
   * Matches all routes agains the incoming request. If a match is found, then the matched route is returned.
   * @returns matched route
   */
  async matchURLPath(rawPath: string, method: string) {
    let path = rawPath !== '/' && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath
    path = path.toLowerCase()
    const { excludedRoutes = [], routes = [] } = this

    const matchingRoute = routes.find((route: ExtendedRoute) => {
      if (route.methods && route.methods.length !== 0 && !route.methods.includes(method)) {
        return false
      }

      if ('literal' in route && route.literal !== undefined) {
        return path === route.literal
      }

      if ('expression' in route && route.expression !== undefined) {
        const regex = new RegExp(route.expression)

        return regex.test(path)
      }

      return false
    })

    if (!matchingRoute) {
      return
    }

    const isExcluded = excludedRoutes.some((excludedRoute: Route) => {
      if ('literal' in excludedRoute && excludedRoute.literal !== undefined) {
        return path === excludedRoute.literal
      }

      if ('expression' in excludedRoute && excludedRoute.expression !== undefined) {
        const regex = new RegExp(excludedRoute.expression)

        return regex.test(path)
      }

      return false
    })

    if (isExcluded) {
      return
    }

    return matchingRoute
  }

  private normalizeError(error: Error | InvocationError): InvocationError {
    if (error instanceof Error) {
      const normalizedError: InvocationError = {
        errorMessage: error.message,
        errorType: error.name,
        stackTrace: error.stack ? error.stack.split('\n') : [],
      }

      if ('code' in error && error.code === 'ERR_REQUIRE_ESM') {
        return {
          ...normalizedError,
          errorMessage:
            'a CommonJS file cannot import ES modules. Consider switching your function to ES modules. For more information, refer to https://ntl.fyi/functions-runtime.',
        }
      }

      return normalizedError
    }

    // Formatting stack trace lines in the same way that Node.js formats native errors.
    const stackTrace = error.stackTrace.map((line) => `    at ${line}`)

    return {
      errorType: error.errorType,
      errorMessage: error.errorMessage,
      stackTrace,
    }
  }

  get runtimeAPIVersion() {
    return this.buildData?.runtimeAPIVersion ?? 1
  }

  setRoutes(routes: FunctionResult['routes']) {
    if (this.buildData) {
      this.buildData.routes = routes
    }
  }

  get url() {
    // This line fixes the issue here https://github.com/netlify/cli/issues/4116
    // Not sure why `settings.port` was used here nor does a valid reference exist.
    // However, it remains here to serve whatever purpose for which it was added.
    const port = this.settings.port || this.settings.functionsPort
    const protocol = this.settings.https ? 'https' : 'http'
    const url = new URL(`/.netlify/functions/${this.name}`, `${protocol}://localhost:${port}`)

    return url.href
  }
}
