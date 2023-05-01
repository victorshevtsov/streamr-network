import express from 'express'
import cors from 'cors'
import {
    addRttsToNodeConnections,
    findStreamsPartsForNode,
    getNodeConnections,
    getTopology,
    getStreamPartSizes,
    getNodesWithLocationData
} from './trackerSummaryUtils'
import { Logger } from '@streamr/utils'
import { Tracker } from './Tracker'
import http from 'http'
import https from 'https'
import morgan from 'morgan'
import compression from 'compression'
import { StreamID, toStreamID } from '@streamr/protocol'

const logger = new Logger(module)

const respondWithError = (res: express.Response, errorMessage: string): void => {
    res.status(422).json({
        errorMessage
    })
}

const validateStreamId = (req: express.Request, res: express.Response): StreamID | null => {
    const streamId = decodeURIComponent(req.params.streamId).trim()
    if (streamId.length === 0) {
        logger.warn('422 streamId must be a not empty string')
        respondWithError(res, 'streamId cannot be empty')
        return null
    }
    return toStreamID(streamId)
}

const validatePartition = (req: express.Request, res: express.Response): number | null => {
    const partition = Number.parseInt(req.params.partition, 10)
    if (!Number.isSafeInteger(partition) || partition < 0) {
        logger.warn('422 partition must be a positive integer', { askedPartition: partition })
        respondWithError(res, `partition must be a positive integer (was ${partition})`)
        return null
    }
    return partition
}

const cachedJsonGet = (
    app: express.Application,
    endpoint: string,
    maxAge: number,
    jsonFactory: () => any
): express.Application => {
    let cache: undefined | {
        timestamp: number
        json: string
    }
    return app.get(endpoint, (_req: express.Request, res: express.Response) => {
        logger.debug('Request to endpoint', { endpoint })
        if ((cache === undefined) || (Date.now() > (cache.timestamp + maxAge))) {
            cache = {
                json: JSON.stringify(jsonFactory()),
                timestamp: Date.now()
            }
        }
        res.setHeader('Content-Type', 'application/json')
        res.send(cache.json)
    })
}

export function trackerHttpEndpoints(
    httpServer: http.Server | https.Server,
    tracker: Tracker
): void {
    const app = express()
    app.use(cors())
    app.use(compression())
    app.use(morgan(process.env.CUSTOM_MORGAN_FORMAT ?? ':method :url :status :response-time ms - :res[content-length] - :remote-addr'))
    httpServer.on('request', app)

    app.get('/topology/', (_req: express.Request, res: express.Response) => {
        logger.debug('Request to /topology/')
        res.json(getTopology(tracker.getOverlayPerStreamPart(), tracker.getOverlayConnectionRtts()))
    })
    app.get('/topology/:streamId/', (req: express.Request, res: express.Response) => {
        const streamId = validateStreamId(req, res)
        if (streamId === null) {
            return
        }

        logger.debug(`Request to /topology/${streamId}/`)
        res.json(getTopology(tracker.getOverlayPerStreamPart(), tracker.getOverlayConnectionRtts(), streamId, null))
    })
    app.get('/topology/:streamId/:partition/', (req: express.Request, res: express.Response) => {
        const streamId = validateStreamId(req, res)
        if (streamId === null) {
            return
        }

        const askedPartition = validatePartition(req, res)
        if (askedPartition === null) {
            return
        }

        logger.debug(`Request to /topology/${streamId}/${askedPartition}/`)
        res.json(getTopology(tracker.getOverlayPerStreamPart(), tracker.getOverlayConnectionRtts(), streamId, askedPartition))
    })
    cachedJsonGet(app, '/node-connections/', 5 * 60 * 1000, () => {
        const topologyUnion = getNodeConnections(tracker.getNodes(), tracker.getOverlayPerStreamPart())
        return Object.assign({}, ...Object.entries(topologyUnion).map(([nodeId, neighbors]) => {
            return addRttsToNodeConnections(nodeId, Array.from(neighbors), tracker.getOverlayConnectionRtts())
        }))
    })
    app.get('/nodes/:nodeId/streams', async (req: express.Request, res: express.Response) => {
        const { nodeId } = req.params
        logger.debug(`Request to /nodes/${nodeId}/streams`)
        const result = findStreamsPartsForNode(tracker.getOverlayPerStreamPart(), nodeId)
        res.json(result)
    })
    app.get('/location/', (_req: express.Request, res: express.Response) => {
        logger.debug('Request to /location/')
        res.json(getNodesWithLocationData(tracker.getNodes(), tracker.getAllNodeLocations()))
    })
    app.get('/location/:nodeId/', (req: express.Request, res: express.Response) => {
        const { nodeId } = req.params
        const location = tracker.getNodeLocation(nodeId)

        logger.debug(`Request to /location/${nodeId}/`)
        res.json(location || {})
    })
    app.get('/metadata/', (_req: express.Request, res: express.Response) => {
        logger.debug('Request to /metadata/')
        res.json(tracker.getAllExtraMetadatas())
    })
    app.get('/topology-size/', async (_req: express.Request, res: express.Response) => {
        logger.debug('Request to /topology-size/')
        res.json(getStreamPartSizes(tracker.getOverlayPerStreamPart()))
    })
    app.get('/topology-size/:streamId/', async (req: express.Request, res: express.Response) => {
        const streamId = validateStreamId(req, res)
        if (streamId === null) {
            return
        }

        logger.debug(`Request to /topology-size/${streamId}/`)
        res.json(getStreamPartSizes(tracker.getOverlayPerStreamPart(), streamId, null))
    })
    app.get('/topology-size/:streamId/:partition/', async (req: express.Request, res: express.Response) => {
        const streamId = validateStreamId(req, res)
        if (streamId === null) {
            return
        }

        const askedPartition = validatePartition(req, res)
        if (askedPartition === null) {
            return
        }

        logger.debug(`Request to /topology-size/${streamId}/${askedPartition}/`)
        res.json(getStreamPartSizes(tracker.getOverlayPerStreamPart(), streamId, askedPartition))
    })
}
