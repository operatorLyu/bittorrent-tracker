module.exports = Swarm

const arrayRemove = require('unordered-array-remove')
const debug = require('debug')('bittorrent-tracker:swarm')
const LRU = require('lru')
const randomIterate = require('random-iterate')

// Regard this as the default implementation of an interface that you
// need to support when overriding Server.createSwarm() and Server.getSwarm()
function Swarm (infoHash, server) {
  const self = this
  self.infoHash = infoHash
  self.complete = 0
  self.incomplete = 0
  self.serverPeerCnt = 0
  self.serverPeerLimit = 3
  self.serverPeerList = new Array()
  self.normalPeerList = new Array()

  self.peers = new LRU({
    max: server.peersCacheLength || 1000,
    maxAge: server.peersCacheTtl || 20 * 60 * 1000 // 20 minutes
  })

  // When a peer is evicted from the LRU store, send a synthetic 'stopped' event
  // so the stats get updated correctly.
  self.peers.on('evict', function (data) {
    const peer = data.value
    const params = {
      type: peer.type,
      event: 'stopped',
      numwant: 0,
      peer_id: peer.peerId
    }
    self._onAnnounceStopped(params, peer, peer.peerId)
    peer.socket = null
  })
}

Swarm.prototype.announce = function (params, cb) {
  const self = this
  const id = params.type === 'ws' ? params.peer_id : params.addr
  // Mark the source peer as recently used in cache
  const peer = self.peers.get(id)
  
  if (params.event === 'started') {
    self._onAnnounceStarted(params, peer, id)
  } else if (params.event === 'stopped') {
    self._onAnnounceStopped(params, peer, id)
  } else if (params.event === 'completed') {
    self._onAnnounceCompleted(params, peer, id)
  } else if (params.event === 'update') {
    self._onAnnounceUpdate(params, peer, id)
  } else {
    cb(new Error('invalid event'))
    return
  }
  let peerTest
  peerTest = self.peers.get(id)
  console.log("peer:"+peerTest)
  if (peerTest){
    cb(null, {
      complete: self.complete,
      incomplete: self.incomplete,
      peers: self._getPeers(params.numwant, params.peer_id, !!params.socket, peerTest.serverPeerNo),
      serverPeer: peerTest.serverPeerNo
    })
  }

  
}

Swarm.prototype.scrape = function (params, cb) {
  cb(null, {
    complete: this.complete,
    incomplete: this.incomplete
  })
}

Swarm.prototype._onAnnounceStarted = function (params, peer, id) {
  if (peer) {
    debug('unexpected `started` event from peer that is already in swarm')
    return this._onAnnounceUpdate(params, peer, id) // treat as an update
  }
  //added by liuxi
  let serverPeerNumber
  serverPeerNumber = -1
  if(this.serverPeerCnt<this.serverPeerLimit){
    serverPeerNumber=this.serverPeerCnt
    this.serverPeerCnt++
  }
  if(serverPeerNumber === -1){
    this.normalPeerList.push(id)
    console.log("normalPeerList:"+this.normalPeerList)
  }else{
    this.serverPeerList.push(id)
    console.log("serverPeerList:"+this.serverPeerList)
  }
  
  if (params.left === 0) this.complete += 1
  else this.incomplete += 1
  this.peers.set(id, {
    type: params.type,
    complete: params.left === 0,
    peerId: params.peer_id, // as hex
    ip: params.ip,
    port: params.port,
    socket: params.socket, // only websocket
    serverPeerNo: serverPeerNumber  //added by liuxi
  })
  console.log("started, serverPeerNo: "+this.peers.get(id).serverPeerNo)
}

Swarm.prototype._onAnnounceStopped = function (params, peer, id) {
  if (!peer) {
    debug('unexpected `stopped` event from peer that is not in swarm')
    return // do nothing
  }

  if (peer.complete) this.complete -= 1
  else this.incomplete -= 1

  //added by liuxi, in order to switch the serverPeerNo to others
  if(peer.serverPeerNo === -1){
    this.normalPeerList.splice(this.normalPeerList.indexOf(peer.peerId),1)
  }
  else{
    if(this.normalPeerList.length>0){
      let subPeerId
      subPeerId=this.normalPeerList.shift()
      this.peers.get(subPeerId).serverPeerNo=peer.serverPeerNo
      this.serverPeerList.splice(this.serverPeerList.indexOf(peer.peerId),1)
      this.serverPeerList.push(subPeerId)
    }
    else{
      this.serverPeerList.splice(this.serverPeerList.indexOf(peer.peerId),1)
      this.serverPeerCnt--
    }
  }

  // If it's a websocket, remove this swarm's infohash from the list of active
  // swarms that this peer is participating in.
  if (peer.socket && !peer.socket.destroyed) {
    const index = peer.socket.infoHashes.indexOf(this.infoHash)
    arrayRemove(peer.socket.infoHashes, index)
  }

  this.peers.remove(id)
}

Swarm.prototype._onAnnounceCompleted = function (params, peer, id) {
  if (!peer) {
    debug('unexpected `completed` event from peer that is not in swarm')
    return this._onAnnounceStarted(params, peer, id) // treat as a start
  }
  if (peer.complete) {
    debug('unexpected `completed` event from peer that is already completed')
    return this._onAnnounceUpdate(params, peer, id) // treat as an update
  }

  this.complete += 1
  this.incomplete -= 1
  peer.complete = true
  this.peers.set(id, peer)
}

Swarm.prototype._onAnnounceUpdate = function (params, peer, id) {
  if (!peer) {
    debug('unexpected `update` event from peer that is not in swarm')
    return this._onAnnounceStarted(params, peer, id) // treat as a start
  }

  if (!peer.complete && params.left === 0) {
    this.complete += 1
    this.incomplete -= 1
    peer.complete = true
  }
  this.peers.set(id, peer)
}

Swarm.prototype._getPeers = function (numwant, ownPeerId, isWebRTC, serverPeerNo) {
  const peers = []
  const ite = randomIterate(this.peers.keys)
  let peerId
  while ((peerId = ite()) && peers.length < numwant) {
    // Don't mark the peer as most recently used on announce
    const peer = this.peers.peek(peerId)
    if (!peer) continue
    if (isWebRTC && peer.peerId === ownPeerId) continue // don't send peer to itself
    if ((isWebRTC && peer.type !== 'ws') || (!isWebRTC && peer.type === 'ws')) continue // send proper peer type
    if (serverPeerNo !== -1 && peer.serverPeerNo !== -1) continue //added by liuxi, don't send server peer to server peer
    if (serverPeerNo === -1 && peer.serverPeerNo === -1) continue //added by liuxi, don't send normal peer to normal peer
    peers.push(peer)
  }
  return peers
}
