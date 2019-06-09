const events = require('events')
const debug = require('debug')('streamr:MqttServer')

const uuidv4 = require('uuid/v4')
const mqttCon = require('mqtt-connection')

const { MessageLayer } = require('streamr-client-protocol')
const VolumeLogger = require('../VolumeLogger')
const partition = require('../partition')

const StreamStateManager = require('../StreamStateManager')
const Connection = require('./Connection')

module.exports = class MqttServer extends events.EventEmitter {
    constructor(
        mqttServer,
        streamsTimeout,
        networkNode,
        streamFetcher,
        publisher,
        volumeLogger = new VolumeLogger(0),
        partitionFn = partition,
    ) {
        super()
        this.mqttServer = mqttServer
        this.streamsTimeout = streamsTimeout
        this.networkNode = networkNode
        this.streamFetcher = streamFetcher
        this.publisher = publisher
        this.partitionFn = partitionFn
        this.volumeLogger = volumeLogger

        this.streams = new StreamStateManager()

        this.networkNode.addMessageListener(this.broadcastMessage.bind(this))
        this.mqttServer.on('connection', this.onNewClientConnection.bind(this))
    }

    close() {
        this.streams.close()
        this.mqttServer.close()
    }

    onNewClientConnection(stream) {
        const client = mqttCon(stream)
        let connection

        client.on('connect', (packet) => {
            debug('connect request %o', packet)

            const { username, password } = packet
            const apiKey = password.toString()

            this.streamFetcher.getToken(apiKey)
                .then((res) => {
                    if (res.code) {
                        client.connack({
                            returnCode: 4
                        })
                    }

                    if (res.token) {
                        client.connack({
                            returnCode: 0
                        })

                        connection = new Connection(client, packet.clientId)
                        this.volumeLogger.connectionCount += 1
                        debug('onNewClientConnection: mqtt "%s" connected', connection.id)

                        client.id = connection.id
                        client.token = res.token
                        client.apiKey = apiKey

                        // timeout idle streams after X minutes
                        stream.setTimeout(this.streamsTimeout)

                        // connection error handling
                        client.on('close', () => {
                            debug('closing client')
                            this._closeClient(connection)
                        })
                        client.on('error', () => {
                            debug('error in client')
                            this._closeClient(connection)
                        })
                        client.on('disconnect', () => {
                            debug('client disconnected')
                            // this._closeClient(connection)
                        })

                        // stream timeout
                        stream.on('timeout', () => {
                            debug('client timeout')
                            this._closeClient(connection)
                        })
                    }
                })
        })

        // client published
        client.on('publish', (packet) => {
            debug('publish request %o', packet)

            const { topic, payload } = packet

            let i = 0

            this.streamFetcher.getStream(topic, client.token)
                .then((streamObj) => {
                    this.streamFetcher.authenticate(streamObj.id, client.apiKey, client.token, 'write')
                        .then((json) => {
                            const streamId = streamObj.id
                            const msgChainId = 'test-chain'
                            const streamPartition = this.partitionFn(streamObj.partitions, 0)
                            const streamMessage = this.createStreamMessage(
                                streamId, JSON.parse(payload), i, Date.now(), uuidv4()
                            )
                            i += 1

                            this.publisher.publish(streamObj, streamMessage)

                            client.puback({
                                messageId: packet.messageId
                            })
                        })
                        .catch((err) => {
                            console.log(err)
                        })
                })
        })

        // client pinged
        client.on('pingreq', () => {
            // send a pingresp
            client.pingresp()
        })

        // client subscribed
        client.on('subscribe', (packet) => {
            debug('subscribe request %o', packet)

            const { topic } = packet.subscriptions[0]

            this.streamFetcher.getStream(topic, client.token)
                .then((streamObj) => {
                    this.streamFetcher.authenticate(streamObj.id, client.apiKey, client.sessionToken)
                        .then((/* streamJson */) => {
                            const newOrExistingStream = this.streams.getOrCreate(streamObj.id, 0, streamObj.name)

                            // Subscribe now if the stream is not already subscribed or subscribing
                            if (!newOrExistingStream.isSubscribed() && !newOrExistingStream.isSubscribing()) {
                                newOrExistingStream.setSubscribing()
                                this.networkNode.subscribe(streamObj.id, 0)
                                newOrExistingStream.setSubscribed()

                                newOrExistingStream.addConnection(connection)
                                connection.addStream(newOrExistingStream)
                                debug(
                                    'handleSubscribeRequest: client "%s" is now subscribed to streams "%o"',
                                    connection.id, connection.streamsAsString()
                                )

                                client.suback({
                                    granted: [packet.qos], messageId: packet.messageId
                                })
                            } else {
                                console.error('error')
                            }
                        })
                        .catch((response) => {
                            console.log(response)
                        })
                })
        })
    }

    _closeClient(connection) {
        this.volumeLogger.connectionCount -= 1
        debug('closing client "%s" on streams "%o"', connection.id, connection.streamsAsString())

        // Unsubscribe from all streams
        connection.forEachStream((stream) => {
            // connection.client.unsubscribe(stream.getName())
        })

        connection.client.destroy()
    }

    broadcastMessage({
        streamId,
        streamPartition,
        timestamp,
        sequenceNo,
        publisherId,
        msgChainId,
        previousTimestamp,
        previousSequenceNo,
        data,
        signatureType,
        signature,
    }) {
        const stream = this.streams.get(streamId, streamPartition)

        if (stream) {
            stream.forEachConnection((connection) => {
                // TODO: performance fix, no need to re-create on every loop iteration
                const payload = JSON.stringify(data)

                const object = {
                    cmd: 'publish',
                    topic: stream.name,
                    payload
                }

                connection.client.publish(object, () => {})
            })

            this.volumeLogger.logOutput(data.length * stream.getConnections().length)
        } else {
            debug('broadcastMessage: stream "%s::%d" not found', streamId, streamPartition)
        }
    }

    // eslint-disable-next-line class-methods-use-this
    createStreamMessage(streamId, data, sequenceNumber, timestamp = Date.now(), messageChaindId = null) {
        return MessageLayer.StreamMessage.create(
            [streamId, 0, Date.now(), sequenceNumber,
                '0x8a9b2ca74d8c1c095d34de3f3cdd7462a5c9c9f4b84d11270a0ad885958bb963', messageChaindId], 0,
            MessageLayer.StreamMessage.CONTENT_TYPES.JSON, data, MessageLayer.StreamMessage.SIGNATURE_TYPES.NONE, null,
        )
    }
}

