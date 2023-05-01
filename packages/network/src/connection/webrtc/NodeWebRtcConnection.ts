import { EventEmitter } from 'events'
import StrictEventEmitter from 'strict-event-emitter-types'
import nodeDataChannel, { DataChannel, DescriptionType, LogLevel, PeerConnection } from 'node-datachannel'
import { ConstructorOptions, WebRtcConnection } from './WebRtcConnection'
import { Logger } from "@streamr/utils"
import { NameDirectory } from "../../NameDirectory"
import { WebRtcConnectionFactory } from "./WebRtcEndpoint"
import { iceServerAsString } from './iceServerAsString'

const loggerLevel = process.env.NODE_DATACHANNEL_LOG_LEVEL || 'Fatal'
nodeDataChannel.initLogger(loggerLevel as LogLevel)

/**
 * Parameters that would be passed to an event handler function
 * e.g.
 * HandlerParameters<SomeClass['onSomeEvent']> will map to the list of
 * parameters that would be passed to `fn` in: `someClass.onSomeEvent(fn)`
 */
type HandlerParameters<T extends (...args: any[]) => any> = Parameters<Parameters<T>[0]>

interface PeerConnectionEvents {
    stateChange: (...args: HandlerParameters<PeerConnection['onStateChange']>) => void
    gatheringStateChange: (...args: HandlerParameters<PeerConnection['onGatheringStateChange']>) => void
    localDescription: (...args: HandlerParameters<PeerConnection['onLocalDescription']>) => void
    localCandidate: (...args: HandlerParameters<PeerConnection['onLocalCandidate']>) => void
    dataChannel: (...args: HandlerParameters<PeerConnection['onDataChannel']>) => void
    error: (err: Error) => void
}

/**
 * Create an EventEmitter that fires appropriate events for
 * each peerConnection.onEvent handler.
 *
 * Wrapping allows us to trivially clear all event handlers.
 * There's no way to reliably stop PeerConnection from running an event handler
 * after you've passed it. Closing a connection doesn't prevent handlers from firing.
 * Replacing handlers with noops doesn't work reliably, it can still fire the old handlers.
 */
function PeerConnectionEmitter(connection: PeerConnection) {
    const emitter: StrictEventEmitter<EventEmitter, PeerConnectionEvents> = new EventEmitter()
    emitter.on('error', () => {}) // noop to prevent unhandled error event
    connection.onStateChange((...args: HandlerParameters<PeerConnection['onStateChange']>) => emitter.emit('stateChange', ...args))
    connection.onGatheringStateChange((...args: HandlerParameters<PeerConnection['onGatheringStateChange']>) => (
        emitter.emit('gatheringStateChange', ...args)
    ))
    connection.onLocalDescription((...args: HandlerParameters<PeerConnection['onLocalDescription']>) => emitter.emit('localDescription', ...args))
    connection.onLocalCandidate((...args: HandlerParameters<PeerConnection['onLocalCandidate']>) => emitter.emit('localCandidate', ...args))
    connection.onDataChannel((...args: HandlerParameters<PeerConnection['onDataChannel']>) => emitter.emit('dataChannel', ...args))
    return emitter
}

interface DataChannelEvents {
    open: (...args: HandlerParameters<DataChannel['onOpen']>) => void
    closed: (...args: HandlerParameters<DataChannel['onClosed']>) => void
    error: (...args: HandlerParameters<DataChannel['onError']>) => void
    bufferedAmountLow: (...args: HandlerParameters<DataChannel['onBufferedAmountLow']>) => void
    message: (...args: HandlerParameters<DataChannel['onMessage']>) => void
}

function DataChannelEmitter(dataChannel: DataChannel) {
    const emitter: StrictEventEmitter<EventEmitter, DataChannelEvents> = new EventEmitter()
    emitter.on('error', () => {}) // noop to prevent unhandled error event
    dataChannel.onOpen((...args: HandlerParameters<DataChannel['onOpen']>) => emitter.emit('open', ...args))
    dataChannel.onClosed((...args: HandlerParameters<DataChannel['onClosed']>) => emitter.emit('closed', ...args))
    dataChannel.onError((...args: HandlerParameters<DataChannel['onError']>) => emitter.emit('error', ...args))
    dataChannel.onBufferedAmountLow((...args: HandlerParameters<DataChannel['onBufferedAmountLow']>) => emitter.emit('bufferedAmountLow', ...args))
    dataChannel.onMessage((...args: HandlerParameters<DataChannel['onMessage']>) => emitter.emit('message', ...args))
    return emitter
}

export const webRtcConnectionFactory = new class implements WebRtcConnectionFactory {
    activeWebRtcEndpointCount = 0
    logger = new Logger(module)
    // eslint-disable-next-line class-methods-use-this
    createConnection(opts: ConstructorOptions): WebRtcConnection {
        return new NodeWebRtcConnection(opts)
    }
    registerWebRtcEndpoint(): void {
        this.activeWebRtcEndpointCount++
    }
    unregisterWebRtcEndpoint(): void {
        this.activeWebRtcEndpointCount--
        if (this.activeWebRtcEndpointCount === 0) {
            this.logger.debug('Clean up nodeDataChannel library')
            nodeDataChannel.cleanup()
        }
    }
}

export class NodeWebRtcConnection extends WebRtcConnection {
    private readonly logger: Logger
    private connection: PeerConnection | null
    private dataChannel: DataChannel | null
    private dataChannelEmitter?: EventEmitter
    private connectionEmitter?: EventEmitter
    private lastState?: string
    private lastGatheringState?: string
    private remoteDescriptionSet = false

    constructor(opts: ConstructorOptions) {
        super(opts)

        this.logger = new Logger(module, { id: `${NameDirectory.getName(this.getPeerId())}/${this.id}` })
        this.connection = null
        this.dataChannel = null
        this.onStateChange = this.onStateChange.bind(this)
        this.onLocalCandidate = this.onLocalCandidate.bind(this)
        this.onLocalDescription = this.onLocalDescription.bind(this)
        this.onGatheringStateChange = this.onGatheringStateChange.bind(this)
        this.onDataChannel = this.onDataChannel.bind(this)

    }

    protected doSendMessage(message: string): boolean {
        return this.dataChannel!.sendMessage(message)
    }

    protected doConnect(): void {
        this.connection = new nodeDataChannel.PeerConnection(this.selfId, {
            iceServers: this.iceServers.map(iceServerAsString),
            maxMessageSize: this.maxMessageSize,
            portRangeBegin: this.portRange.min,
            portRangeEnd: this.portRange.max
        })

        this.connectionEmitter = PeerConnectionEmitter(this.connection)

        this.connectionEmitter.on('stateChange', this.onStateChange)
        this.connectionEmitter.on('gatheringStateChange', this.onGatheringStateChange)
        this.connectionEmitter.on('localDescription', this.onLocalDescription)
        this.connectionEmitter.on('localCandidate', this.onLocalCandidate)

        if (this.isOffering()) {
            const dataChannel = this.connection.createDataChannel('streamrDataChannel')
            this.setupDataChannel(dataChannel)
        } else {
            this.connectionEmitter.on('dataChannel', this.onDataChannel)
        }
    }

    setRemoteDescription(description: string, type: DescriptionType): void {
        if (this.connection) {
            try {
                this.connection.setRemoteDescription(description, type)
                this.remoteDescriptionSet = true
            } catch (err) {
                this.logger.warn('Failed to set remote description', err)
            }
        } else {
            this.logger.warn('Skipped setting remote description (connection is null)')
        }
    }

    addRemoteCandidate(candidate: string, mid: string): void {
        if (this.connection) {
            if (this.remoteDescriptionSet) {
                try {
                    this.connection.addRemoteCandidate(candidate, mid)
                } catch (err) {
                    this.logger.warn('Failed to add remote candidate', err)
                    this.close(new Error('addRemoteCandidate failed'))
                }
            } else {
                this.logger.warn("Close connection (tried setting remote candidate before remote description)")
                this.close(new Error('Tried setting remoteCandidate before remote description'))
            }
        } else {
            this.logger.warn('Skipped adding remote candidate (connection is null)')
        }
    }

    protected doClose(_err?: Error): void {
        if (this.connectionEmitter) {
            this.connectionEmitter.removeAllListeners()
        }

        if (this.dataChannelEmitter) {
            this.dataChannelEmitter.removeAllListeners()
        }

        if (this.connection) {
            try {
                this.connection.close()
            } catch (e) {
                this.logger.warn('Encountered error while closing connection', e)
            }
        }

        if (this.dataChannel) {
            try {
                this.dataChannel.close()
            } catch (e) {
                this.logger.warn('Encountered error while closing dataChannel', e)
            }
        }

        this.dataChannel = null
        this.connection = null
        this.lastState = undefined
        this.lastGatheringState = undefined
    }

    getBufferedAmount(): number {
        try {
            return this.dataChannel!.bufferedAmount().valueOf()
        } catch (err) {
            return 0
        }
    }

    getMaxMessageSize(): number {
        try {
            return this.dataChannel!.maxMessageSize().valueOf()
        } catch (err) {
            return 1024 * 1024
        }
    }

    isOpen(): boolean {
        try {
            return this.dataChannel!.isOpen()
        } catch (err) {
            return false
        }
    }

    getLastState(): string | undefined {
        return this.lastState
    }

    getLastGatheringState(): string | undefined {
        return this.lastGatheringState
    }

    private onStateChange(state: string): void {
        this.logger.trace('onStateChange', {
            lastState: this.lastState,
            state
        })

        this.lastState = state

        if (state === 'disconnected' || state === 'closed') {
            this.close()
        } else if (state === 'failed') {
            this.close(new Error('connection failed'))
        } else if (state === 'connecting') {
            this.restartConnectionTimeout()
        }
    }

    private onGatheringStateChange(state: string): void {
        this.logger.trace('onGatheringStateChange', {
            lastState: this.lastGatheringState,
            state
        })
        this.lastGatheringState = state
    }

    private onDataChannel(dataChannel: DataChannel): void {
        this.setupDataChannel(dataChannel)
        this.logger.trace('connection.onDataChannel')
        this.openDataChannel(dataChannel)
    }

    private onLocalDescription(description: string, type: DescriptionType): void {
        this.emitLocalDescription(description, type)
    }

    private onLocalCandidate(candidate: string, mid: string): void {
        this.emitLocalCandidate(candidate, mid)
    }

    private setupDataChannel(dataChannel: DataChannel): void {
        this.dataChannelEmitter = DataChannelEmitter(dataChannel)
        dataChannel.setBufferedAmountLowThreshold(this.bufferThresholdLow)
        this.dataChannelEmitter.on('open', () => {
            this.logger.trace('dataChannelEmitter.onOpen')
            this.openDataChannel(dataChannel)
        })

        this.dataChannelEmitter.on('closed', () => {
            this.logger.trace('dataChannelEmitter.onClosed')
            this.close()
        })

        this.dataChannelEmitter.on('error', (err) => {
            this.logger.warn('Encountered error (emitted by dataChannelEmitter)', err)
        })

        this.dataChannelEmitter.on('bufferedAmountLow', () => {
            this.emitLowBackpressure()
        })

        this.dataChannelEmitter.on('message', (msg) => {
            this.logger.trace('dataChannelEmitter.onmessage')
            this.emitMessage(msg.toString())
        })
    }

    private openDataChannel(dataChannel: DataChannel): void {
        this.dataChannel = dataChannel
        this.emitOpen()
    }
}
