'use strict'

/**
 * @exports
 * @class
 */
module.exports = class Penguin {
  /**
   * @constructor
   * @param {Server} server
   * @param {Socket} socket
   */
  constructor(server, socket) {
    /**
     * The server
     * @type {Server}
     */
    this.server = server
    /**
     * The socket
     * @type {Socket}
     */
    this.socket = socket
    /**
     * The xml stage
     * @type {Number}
     */
    this.stage = 0
  }

  /**
   * Set the penguin
   * @param {Object} result
   */
  async setPenguin(result) {
    const date = new Date().toISOString().split('T')[0].split('-').join('')

    delete result.password
    delete this.stage

    for (const key in result) {
      this[key] = result[key]
    }

    delete this.created

    this.moderator = Boolean(this.moderator)
    this.muted = Boolean(this.muted)
    this.age = Number(date - result.created)

    this.x = this.y = this.coinsDug = 0
    this.frame = 1
    this.requests = []

    this.inventory = await this.server.database.knex('inventory').pluck('itemId').where('id', this.id)
    this.ignored = await this.server.database.knex('ignore').select('ignoreId', 'ignoreUsername').where('id', this.id)
    this.buddies = await this.server.database.knex('buddy').select('buddyId', 'buddyUsername').where('id', this.id)

    // Stuff to convert to an object when needed
    if (this.ignored.length > 0) this.ignored = this.ignored.reduce((o, i) => (o[i.ignoreId] = i.ignoreUsername, o), {})
    if (this.buddies.length > 0) this.buddies = this.buddies.reduce((o, i) => (o[i.buddyId] = i.buddyUsername, o), {})
  }

  /**
   * Add an ignore
   * @param {Number} ignoreId
   */
  async addIgnore(ignoreId) {
    if (!this.ignored[ignoreId]) {
      const ignoreObj = this.server.getPenguinById(ignoreId)

      if (ignoreObj) {
        const ignoreUsername = ignoreObj.username

        this.ignored[ignoreId] = ignoreUsername

        await this.server.database.knex('ignore').insert({ id: this.id, ignoreId, ignoreUsername })
      } else {
        const result = await this.server.database.knex('penguins').select('username').first('*').where({ id: ignoreId })

        if (!result) {
          return this.disconnect()
        }

        const ignoreUsername = result[0].username

        this.ignored[ignoreId] = ignoreUsername

        await this.server.database.knex('ignore').insert({ id: this.id, ignoreId, ignoreUsername })
      }
    }
  }

  /**
   * Remove an ignore
   * @param {Number} ignoreId
   */
  async removeIgnore(ignoreId) {
    if (this.ignored[ignoreId]) {
      delete this.ignored[ignoreId]

      await this.server.database.knex('ignore').where('ignoreId', ignoreId).del()
    }
  }

  /**
   * Add a buddy
   * @param {Number} buddyId
   */
  async addBuddy(buddyId) {
    if (Object.keys(this.buddies).length >= 500) {
      return this.sendError(901)
    }

    const idx = this.requests.indexOf(buddyId)

    // Not ignoring, not already buddies and the buddy requested
    if (!this.ignored[buddyId] && !this.buddies[buddyId] && idx > -1) {
      const buddyObj = this.server.getPenguinById(buddyId)

      // Both must be online
      if (buddyObj) {
        // If the buddy is not buddy with us
        if (!buddyObj.buddies[this.id]) {
          const buddyUsername = buddyObj.username

          // Put ourselves into buddies
          this.buddies[buddyId] = buddyUsername
          buddyObj.buddies[this.id] = this.username

          // Put ourselves into database
          await this.server.database.knex('buddy').insert({ id: this.id, buddyId, buddyUsername })
          await this.server.database.knex('buddy').insert({ id: buddyId, buddyId: this.id, buddyUsername: this.username })

          // Notify that we're buddies
          buddyObj.sendXt('ba', this.id, this.username)

          // Remove the request
          this.requests.splice(idx, 1)
        }
      }
    }
  }

  /**
   * Remove a buddy
   * @param {Number} buddyId
   */
  async removeBuddy(buddyId) {
    if (this.buddies[buddyId]) {
      delete this.buddies[buddyId]

      await this.server.database.knex('buddy').where('buddyId', buddyId).del()
    }

    const buddyObj = this.server.getPenguinById(buddyId)

    // If the buddy is online and our buddy, delete us stored buddies
    if (buddyObj && buddyObj.buddies[this.id]) {
      delete buddyObj.buddies[this.id]
    }

    await this.server.database.knex('buddy').where('buddyId', this.id).del()

    // Notify that we're not buddies anymore
    if (buddyObj) {
      buddyObj.sendXt('rb', this.id, this.username)
    }
  }

  /**
   * Update the penguin's outfit
   * @param {String} itemType
   * @param {Number} itemId
   */
  async updateOutfit(itemType, itemId) {
    this[itemType] = itemId
    await this.updateColumn(this.id, itemType, itemId)
  }

  /**
   * Remove coins
   * @param {Number} amount
   */
  async removeCoins(amount) {
    this.coins -= amount
    await this.updateColumn(this.id, 'coins', this.coins)
  }

  /**
   * Add coins
   * @param {Number} amount
   */
  async addCoins(amount) {
    this.coins += amount
    await this.updateColumn(this.id, 'coins', this.coins)
  }

  /**
  * Add an item
  * @param {Number} itemId
  */
  async addItem(itemId) {
    if (this.inventory.indexOf(itemId) === -1) {
      this.inventory.push(itemId)

      await this.server.database.knex('inventory').insert({ id: this.id, itemId })

      this.sendXt('ai', itemId, this.coins)
    } else {
      this.sendError(400)
    }
  }

  /**
   * Build the penguin string
   * @returns {String}
   */
  buildString() {
    return [
      this.id,
      this.username,
      1, // Is approved
      this.color,
      this.head,
      this.face,
      this.neck,
      this.body,
      this.hand,
      this.feet,
      this.flag,
      this.photo,
      this.x,
      this.y,
      this.frame,
      1, // Is member
      this.rank * 146 // Membership badge
    ].join('|')
  }

  /**
  * Send raw data to the socket
  * @param {String} data
  * @param {Boolean} log
  */
  send(data, log = true) {
    if (this.socket && this.socket.writable) {
      if (log) {
        logger.outgoing(data)
      }

      this.socket.write(data + '\0')
    }
  }

  /**
   * Send xt data to the socket
   * @param {Array} args
   */
  sendXt(...args) {
    args.splice(1, 0, -1)

    this.send(`%xt%${args.join('%')}%`)
  }

  /**
   * Send an error to the penguin
   * @param {Number} err
   * @param {Boolean} disconnect
   */
  sendError(err, disconnect = false) {
    this.sendXt('e', err)

    if (disconnect) {
      this.disconnect()
    }
  }

  /**
   * Updates a column
   * @param {Number|String} value
   * @param {String} column
   * @param {Number|String} columnValue
   */
  async updateColumn(value, column, columnValue) {
    const type = isNaN(value) ? 'username' : 'id'

    try {
      await this.server.database.knex('penguins').update(column, columnValue).where(type, value)
    } catch (err) {
      this.disconnect()
    }
  }

  /**
   * Join a random room
   */
  joinRandomRoom() {
    this.server.roomManager.joinRandomRoom(this)
  }

  /**
   * Create a new igloo
   * @param {Number} id
   */
  createIgloo(id) {
    this.server.roomManager.createIgloo(id)
  }

  /**
   * Join a room
   * @param {Room} room
   * @param {Number} x
   * @param {Number} y
   */
  joinRoom(room, x, y) {
    room.addPenguin(this, x, y)
  }

  /**
   * Removes the penguin from the room
   */
  removeFromRoom() {
    if (this.room) {
      this.room.removePenguin(this)
    }
  }

  /**
   * Close the penguin's igloo
   */
  closeIgloo() {
    const iglooId = this.id + 1000

    if (this.server.roomManager.checkIgloo(iglooId)) {
      this.server.roomManager.closeIgloo(iglooId)
    }
  }

  /**
   * Return the room
   * @param {Number} id
   * @returns {Room}
   */
  getRoomById(id) {
    return this.server.roomManager.getRoomById(id)
  }

  /**
   * Return if a room is full or not
   * @param {Number} id
   * @returns {Boolean}
   */
  isRoomFull(id) {
    return this.server.roomManager.isRoomFull(id)
  }

  /**
   * Disconnects the penguin
   */
  disconnect() {
    if (serverType !== 'LOGIN') {
      this.removeFromRoom()

      if (Object.keys(this.buddies).length > 0) {
        for (const buddyId in this.buddies) {
          const buddyObj = this.server.getPenguinById(buddyId)

          if (buddyObj) {
            buddyObj.sendXt('bof', this.id)
          }
        }
      }

      this.closeIgloo()
    }

    this.server.removePenguin(this)
  }
}
