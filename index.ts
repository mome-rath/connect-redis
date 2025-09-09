import { type SessionData, Store } from "express-session"
import type { RedisClientType, RedisClusterType } from "redis"

type UserSessionData = SessionData & { userId: string }
type Callback = (_err?: unknown, _data?: any) => any

function optionalCb(err: unknown, data: unknown, cb?: Callback) {
  if (cb) return cb(err, data)
  if (err) throw err
  return data
}

const rxPrefix = /^(?:[\w]+\W|[a-z\d]+[^a-z\d])$/gi // \w includes "_"

interface Serializer {
  parse(s: string): UserSessionData | Promise<UserSessionData>
  stringify(s: UserSessionData): string
}

interface RedisStoreOptions {
  client: any
  prefix?: string
  scanCount?: number
  serializer?: Serializer
  ttl?: number | ((sess: UserSessionData) => number)
  disableTTL?: boolean
  disableTouch?: boolean
}

export class RedisStore extends Store {
  client: RedisClientType | RedisClusterType
  prefix: string
  prefixWOSeparator: string
  separator: string
  scanCount: number
  serializer: Serializer
  ttl: number | ((sess: UserSessionData) => number)
  disableTTL: boolean
  disableTouch: boolean

  constructor(opts: RedisStoreOptions) {
    super()
    this.prefix = opts.prefix == null ? "sess:" : opts.prefix
    if (!rxPrefix.test(this.prefix)) {
      this.prefix += ":"
    }
    rxPrefix.lastIndex = 0 // RESET THIS! Otherwise it will give erroneous values the next time!
    this.prefixWOSeparator = this.prefix.substring(0, this.prefix.length - 1)
    this.separator = this.prefix.charAt(this.prefix.length - 1)
    this.scanCount = opts.scanCount || 100
    this.serializer = opts.serializer || JSON
    this.ttl = opts.ttl || 86400 // One day in seconds.
    this.disableTTL = opts.disableTTL || false
    this.disableTouch = opts.disableTouch || false
    this.client = opts.client
  }

  async get(sid: string, cb?: Callback) {
    let key = this.prefix + sid
    try {
      let data = await this.client.get(key)
      if (!data) return optionalCb(null, null, cb)
      return optionalCb(null, await this.serializer.parse(data), cb)
    } catch (err) {
      return optionalCb(err, null, cb)
    }
  }

  async set(sid: string, sess: UserSessionData, cb?: Callback) {
    let key = this.prefix + sid
    let userKey = this.prefixWOSeparator + sess.userId + this.separator + sid
    let ttl = this.getTTL(sess)
    try {
      if (ttl > 0) {
        let val = this.serializer.stringify(sess)
        if (this.disableTTL) {
          await this.client.set(key, val)
          await this.client.set(userKey, key)
        } else {
          await this.client.set(key, val, {
            expiration: { type: "EX", value: ttl },
          })
          await this.client.set(userKey, key, {
            expiration: { type: "EX", value: ttl },
          })
        }
        return optionalCb(null, null, cb)
      }
      return this.destroy(sid, cb)
    } catch (err) {
      return optionalCb(err, null, cb)
    }
  }

  async touch(sid: string, sess: UserSessionData, cb?: Callback) {
    let key = this.prefix + sid
    let userKey = this.prefixWOSeparator + sess.userId + this.separator + sid
    if (this.disableTouch || this.disableTTL) return optionalCb(null, null, cb)
    try {
      const ttl = this.getTTL(sess)
      await this.client.expire(key, ttl)
      await this.client.expire(userKey, ttl)
      return optionalCb(null, null, cb)
    } catch (err) {
      return optionalCb(err, null, cb)
    }
  }

  async destroy(sid: string, cb?: Callback) {
    let key = this.prefix + sid
    try {
      const data = await this.client.get(key)
      if (data == null) return optionalCb(null, null, cb)
      const sess = await this.serializer.parse(data)
      const userKey =
        this.prefixWOSeparator + sess.userId + this.separator + sid
      await this.client.del([key, userKey])
      return optionalCb(null, null, cb)
    } catch (err) {
      return optionalCb(err, null, cb)
    }
  }

  async clear(cb?: Callback) {
    try {
      let keys = await this.getAllKeys(true)
      if (!keys.length) return optionalCb(null, null, cb)
      await this.client.del(keys)
      return optionalCb(null, null, cb)
    } catch (err) {
      return optionalCb(err, null, cb)
    }
  }

  async clearForUser(uid: string, cb?: Callback) {
    try {
      let keys = await this.getUserKeys(uid)
      if (!keys.length) return optionalCb(null, null, cb)
      await this.client.del(keys)
      return optionalCb(null, null, cb)
    } catch (err) {
      return optionalCb(err, null, cb)
    }
  }

  async length(cb?: Callback) {
    try {
      let keys = await this.getAllKeys(false)
      return optionalCb(null, keys.length, cb)
    } catch (err) {
      return optionalCb(err, null, cb)
    }
  }

  async ids(cb?: Callback) {
    let len = this.prefix.length
    try {
      let keys = await this.getAllKeys(false)
      return optionalCb(
        null,
        keys.map((k) => k.substring(len)),
        cb,
      )
    } catch (err) {
      return optionalCb(err, null, cb)
    }
  }

  async all(cb?: Callback) {
    let len = this.prefix.length
    try {
      let keys = await this.getAllKeys(false)
      if (keys.length === 0) return optionalCb(null, [], cb)

      let data = await this.client.mGet(keys)
      let results = data.reduce((acc, raw, idx) => {
        if (!raw) return acc
        let sess = this.serializer.parse(raw) as any
        sess.id = keys[idx].substring(len)
        acc.push(sess)
        return acc
      }, [] as UserSessionData[])
      return optionalCb(null, results, cb)
    } catch (err) {
      return optionalCb(err, null, cb)
    }
  }

  private getTTL(sess: UserSessionData) {
    if (typeof this.ttl === "function") {
      return this.ttl(sess)
    }

    let ttl
    if (sess?.cookie?.expires) {
      let ms = Number(new Date(sess.cookie.expires)) - Date.now()
      ttl = Math.ceil(ms / 1000)
    } else {
      ttl = this.ttl
    }
    return ttl
  }

  private async getAllKeys(includeUserKeys = false) {
    let pattern = (includeUserKeys ? this.prefixWOSeparator : this.prefix) + "*"
    let set = new Set<string>()
    for await (let keys of this.scanIterator(pattern, this.scanCount)) {
      for (let key of keys) {
        set.add(key)
      }
    }
    return set.size > 0 ? Array.from(set) : []
  }

  private scanIterator(match: string, count: number) {
    let client = this.client

    if (!("masters" in client)) {
      return client.scanIterator({ MATCH: match, COUNT: count })
    }

    return (async function* () {
      for (let master of client.masters) {
        let c = await client.nodeClient(master)
        for await (let keys of c.scanIterator({
          COUNT: count,
          MATCH: match,
        })) {
          yield keys
        }
      }
    })()
  }

  private async getUserKeys(userId: string) {
    const userPrefix = this.prefixWOSeparator + userId + this.separator
    let pattern = userPrefix + "*"
    let set = new Set<string>()
    for await (let keys of this.scanIterator(pattern, this.scanCount)) {
      for (let key of keys) {
        set.add(key)
        set.add(this.prefix + key.substring(userPrefix.length))
      }
    }
    return set.size > 0 ? Array.from(set) : []
  }
}

export default RedisStore
