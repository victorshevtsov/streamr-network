import { EventEmitter } from 'events'

import { TrackerRegistryRecord, StatusMessage, StreamPartID, toStreamPartID } from '@streamr/protocol'
import { Event as TrackerServerEvent, TrackerServer } from '../protocol/TrackerServer'
import { OverlayTopology } from './OverlayTopology'
import { InstructionCounter } from './InstructionCounter'
import { LocationManager } from './LocationManager'
import { attachMessageRelaying } from './attachMessageRelaying'
import {
    PeerId,
    PeerInfo,
    NodeId,
    Location,
    Status,
    StreamPartStatus,
    DisconnectionCode,
    DisconnectionReason,
    COUNTER_UNSUBSCRIBE,
} from '@streamr/network-node'
import { Logger, MetricsContext, MetricsDefinition, Metric, RateMetric } from '@streamr/utils'
import { InstructionAndStatusAckSender } from './InstructionAndStatusAckSender'
import { StatusValidator } from '../helpers/SchemaValidators'

export type TrackerId = string

export enum Event {
    NODE_CONNECTED = 'streamr:tracker:node-connected'
}

export interface TopologyStabilizationOptions {
    debounceWait: number
    maxWait: number
}

export interface TrackerOptions {
    maxNeighborsPerNode: number
    peerInfo: PeerInfo
    protocols: {
        trackerServer: TrackerServer
    }
    metricsContext?: MetricsContext
    topologyStabilization?: TopologyStabilizationOptions
}

export type OverlayPerStreamPart = Record<StreamPartID, OverlayTopology>

// nodeId => connected nodeId => rtt
export type OverlayConnectionRtts = Record<NodeId, Record<NodeId, number>>

interface Metrics extends MetricsDefinition {
    nodeDisconnected: Metric
    nodeStatusProcessed: Metric
}

export interface Tracker {
    on(event: Event.NODE_CONNECTED, listener: (nodeId: NodeId) => void): this
}

// TODO: Testnet (3rd iteration) compatibility, rm when no more testnet nodes
export function convertTestNet3Status(statusMessage: StatusMessage): void {
    if (statusMessage.status.stream !== undefined) {
        const { streamKey } = statusMessage.status.stream
        let id = ''
        let partition = 0
        if (streamKey !== undefined) {
            const [parsedId, parsedPartition] = streamKey.split('::')
            if (parsedId !== undefined) {
                id = parsedId
            }

            if (parsedPartition !== undefined) {
                partition = parseInt(parsedPartition, 10)
            }
        }

        let neighbors = []
        if (statusMessage.status.stream.inboundNodes !== undefined) {
            neighbors = statusMessage.status.stream.inboundNodes
        }

        let counter = 0
        if (statusMessage.status.stream.counter !== undefined) {
            counter = parseInt(statusMessage.status.stream.counter, 10)
        }
        // eslint-disable-next-line no-param-reassign
        statusMessage.status = {
            ...statusMessage.status,
            streamPart: {
                id,
                partition,
                neighbors,
                counter
            }
        }
    }
}

const logger = new Logger(module)

export class Tracker extends EventEmitter {
    private readonly maxNeighborsPerNode: number
    private readonly trackerServer: TrackerServer
    /** @internal */
    public readonly peerInfo: PeerInfo
    private readonly overlayPerStreamPart: OverlayPerStreamPart
    private readonly overlayConnectionRtts: OverlayConnectionRtts
    private readonly locationManager: LocationManager
    private readonly instructionCounter: InstructionCounter
    private readonly instructionAndStatusAckSender: InstructionAndStatusAckSender
    private readonly extraMetadatas: Record<NodeId, Record<string, unknown>>
    private readonly metrics: Metrics
    private readonly statusSchemaValidator: StatusValidator
    private stopped = false

    constructor(opts: TrackerOptions) {
        super()

        if (!Number.isInteger(opts.maxNeighborsPerNode)) {
            throw new Error('maxNeighborsPerNode is not an integer')
        }

        if (!(opts.protocols.trackerServer instanceof TrackerServer)) {
            throw new Error('Provided protocols are not correct')
        }

        const metricsContext = opts.metricsContext || new MetricsContext()
        this.maxNeighborsPerNode = opts.maxNeighborsPerNode
        this.trackerServer = opts.protocols.trackerServer
        this.peerInfo = opts.peerInfo

        this.overlayPerStreamPart = {}
        this.overlayConnectionRtts = {}
        this.locationManager = new LocationManager()
        this.instructionCounter = new InstructionCounter()
        this.extraMetadatas = Object.create(null)

        this.statusSchemaValidator = new StatusValidator()
        this.trackerServer.on(TrackerServerEvent.NODE_CONNECTED, (nodeId) => {
            this.onNodeConnected(nodeId)
        })
        this.trackerServer.on(TrackerServerEvent.NODE_DISCONNECTED, (nodeId) => {
            this.onNodeDisconnected(nodeId)
        })
        this.trackerServer.on(TrackerServerEvent.NODE_STATUS_RECEIVED, (statusMessage, nodeId) => {
            convertTestNet3Status(statusMessage)
            const valid = this.statusSchemaValidator.validate(statusMessage.status, statusMessage.version)
            if (valid) {
                this.processNodeStatus(statusMessage, nodeId)
            } else {
                logger.warn('Received status message with invalid format', { nodeId })
                this.trackerServer.disconnectFromPeer(
                    nodeId,
                    DisconnectionCode.INVALID_PROTOCOL_MESSAGE,
                    DisconnectionReason.INVALID_PROTOCOL_MESSAGE
                )
            }
        })
        attachMessageRelaying(this.trackerServer)

        this.metrics = {
            nodeDisconnected: new RateMetric(),
            nodeStatusProcessed: new RateMetric()
        }
        metricsContext.addMetrics('tracker', this.metrics)

        this.instructionAndStatusAckSender = new InstructionAndStatusAckSender(
            opts.topologyStabilization,
            this.trackerServer.sendInstruction.bind(this.trackerServer),
            this.trackerServer.sendStatusAck.bind(this.trackerServer),
            metricsContext
        )
    }

    onNodeConnected(node: NodeId): void {
        this.emit(Event.NODE_CONNECTED, node)
    }

    onNodeDisconnected(node: NodeId): void {
        logger.debug('Disconnected from node', { node })
        this.metrics.nodeDisconnected.record(1)
        this.removeNode(node)
    }

    processNodeStatus(statusMessage: StatusMessage, source: NodeId): void {
        if (this.stopped) {
            return
        }

        this.metrics.nodeStatusProcessed.record(1)
        const status = statusMessage.status as Status
        const isMostRecent = this.instructionCounter.isMostRecent(status, source)
        if (!isMostRecent) {
            return
        }

        // update RTTs and location
        if (status.rtts) {
            this.overlayConnectionRtts[source] = status.rtts
        }
        this.locationManager.updateLocation({
            nodeId: source,
            location: status.location,
            address: this.trackerServer.resolveAddress(source),
        })
        this.extraMetadatas[source] = status.extra

        const streamPartId = toStreamPartID(status.streamPart.id, status.streamPart.partition)

        // update topology
        this.createTopology(streamPartId)
        this.updateNodeOnStream(source, status.streamPart)
        this.formAndSendInstructions(source, true, streamPartId)
    }

    async stop(): Promise<void> {
        this.instructionAndStatusAckSender.stop()

        await this.trackerServer.stop()
        this.stopped = true
    }

    // Utility method for tests
    getUrl(): string {
        return this.trackerServer.getUrl()
    }

    private createTopology(streamPartId: StreamPartID) {
        if (this.overlayPerStreamPart[streamPartId] == null) {
            this.overlayPerStreamPart[streamPartId] = new OverlayTopology(this.maxNeighborsPerNode)
        }
    }

    private updateNodeOnStream(node: NodeId, status: StreamPartStatus): void {
        const streamPartId = toStreamPartID(status.id, status.partition)
        if (status.counter === COUNTER_UNSUBSCRIBE) {
            this.leaveAndCheckEmptyOverlay(streamPartId, this.overlayPerStreamPart[streamPartId], node)
        } else {
            this.overlayPerStreamPart[streamPartId].update(node, status.neighbors)
        }
    }

    private formAndSendInstructions(
        node: NodeId,
        isRespondingToNodeStatus: boolean,
        streamPartId: StreamPartID,
        forceGenerate = false
    ): void {
        if (this.stopped) {
            return
        }

        const overlay = this.overlayPerStreamPart[streamPartId]
        if (overlay !== undefined) {
            const instructions = overlay.formInstructions(node, forceGenerate)

            const isAloneInTopology = overlay.hasNode(node) && overlay.getNumberOfNodes() === 1

            if (!isAloneInTopology || !isRespondingToNodeStatus || Object.keys(instructions).length > 0) {
                Object.entries(instructions).forEach(([nodeId, newNeighbors]) => {
                    const counterValue = this.instructionCounter.setOrIncrement(nodeId, streamPartId)
                    this.instructionAndStatusAckSender.addInstruction({
                        nodeId,
                        streamPartId,
                        newNeighbors,
                        counterValue
                    })
                })
            } else {
                // Send empty instruction if and only if the node is alone in the topology
                this.instructionAndStatusAckSender.addStatusAck({
                    nodeId: node,
                    streamPartId
                })
            }
        }
    }

    private removeNode(node: NodeId): void {
        delete this.overlayConnectionRtts[node]
        this.locationManager.removeNode(node)
        delete this.extraMetadatas[node]
        Object.entries(this.overlayPerStreamPart)
            .forEach(([streamPartId, overlayTopology]) => {
                this.leaveAndCheckEmptyOverlay(streamPartId as StreamPartID, overlayTopology, node)
            })
    }

    private leaveAndCheckEmptyOverlay(streamPartId: StreamPartID, overlayTopology: OverlayTopology, node: NodeId) {
        const neighbors = overlayTopology.leave(node)
        this.instructionCounter.removeNodeFromStreamPart(node, streamPartId)

        if (overlayTopology.isEmpty()) {
            this.instructionCounter.removeStreamPart(streamPartId)
            delete this.overlayPerStreamPart[streamPartId]
        } else {
            neighbors.forEach((neighbor) => {
                this.formAndSendInstructions(neighbor, false, streamPartId, true)
            })
        }
    }

    getStreamParts(): Iterable<StreamPartID> {
        return Object.keys(this.overlayPerStreamPart) as StreamPartID[]
    }

    getAllNodeLocations(): Readonly<Record<NodeId, Location>> {
        return this.locationManager.getAllNodeLocations()
    }

    getAllExtraMetadatas(): Readonly<Record<NodeId, Record<string, unknown>>> {
        return this.extraMetadatas
    }

    getNodes(): ReadonlyArray<NodeId> {
        return this.trackerServer.getNodeIds()
    }

    getNodeLocation(node: NodeId): Location {
        return this.locationManager.getNodeLocation(node)
    }

    getOverlayConnectionRtts(): OverlayConnectionRtts {
        return this.overlayConnectionRtts
    }

    getOverlayPerStreamPart(): Readonly<OverlayPerStreamPart> {
        return this.overlayPerStreamPart
    }

    getConfigRecord(): TrackerRegistryRecord {
        return {
            id: this.peerInfo.peerId,
            http: this.getUrl().replace(/^ws/, 'http'),
            ws: this.getUrl()
        }
    }

    getTrackerId(): PeerId {
        return this.peerInfo.peerId
    }
}
