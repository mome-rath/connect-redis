import {SessionData, Store} from "express-session"

type UserSessionData = SessionData & {userId: string}

const noop = (_err?: unknown, _data?: any) => {}
const rxPrefix = /^(?:[\w_]+[^\w_]|[\w]+\W)$/gi

interface NormalizedRedisClient {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttl?: number): Promise<string | null>
  expire(key: string, ttl: number): Promise<number | boolean>
  scanIterator(match: string, count: number): AsyncIterable<string>
  del(key: string[]): Promise<number>
  mget(key: string[]): Promise<(string | null)[]>
}

interface Serializer {
  parse(s: string): UserSessionData | Promise<UserSessionData>
  stringify(s: UserSessionData): string
}

interface RedisStoreOptions {
  client: any
  prefix?: string
  scanCount?: number
  serializer?: Serializer
  ttl?: number | {(sess: UserSessionData): number}
  disableTTL?: boolean
  disableTouch?: boolean
}

class RedisStore extends Store {
  client: NormalizedRedisClient
  prefix: string
  prefixWOSeparator: string
  separator: string
  scanCount: number
  serializer: Serializer
  ttl: number | {(sess: UserSessionData): number}
  disableTTL: boolean
  disableTouch: boolean

  constructor(opts: RedisStoreOptions) {
    super()
    this.prefix = opts.prefix == null ? "sess:" : opts.prefix
    if (!rxPrefix.test(this.prefix)) {
      this.prefix += ':'
    }
    this.prefixWOSeparator = this.prefix.substring(0, this.prefix.length - 1)
    this.separator = this.prefix.charAt(this.prefix.length)
    this.scanCount = opts.scanCount || 100
    this.serializer = opts.serializer || JSON
    this.ttl = opts.ttl || 86400 // One day in seconds.
    this.disableTTL = opts.disableTTL || false
    this.disableTouch = opts.disableTouch || false
    this.client = this.normalizeClient(opts.client)
  }

  // Create a redis and ioredis compatible client
  private normalizeClient(client: any): NormalizedRedisClient {
    let isRedis = "scanIterator" in client
    return {
      get: (key) => client.get(key),
      set: (key, val, ttl) => {
        if (ttl) {
          return isRedis
            ? client.set(key, val, {EX: ttl})
            : client.set(key, val, "EX", ttl)
        }
        return client.set(key, val)
      },
      del: (key) => client.del(key),
      expire: (key, ttl) => client.expire(key, ttl),
      mget: (keys) => (isRedis ? client.mGet(keys) : client.mget(keys)),
      scanIterator: (match, count) => {
        if (isRedis) return client.scanIterator({MATCH: match, COUNT: count})

        // ioredis impl.
        return (async function* () {
          let [c, xs] = await client.scan("0", "MATCH", match, "COUNT", count)
          for (let key of xs) yield key
          while (c !== "0") {
            ;[c, xs] = await client.scan(c, "MATCH", match, "COUNT", count)
            for (let key of xs) yield key
          }
        })()
      },
    }
  }

  async get(sid: string, cb = noop) {
    let key = this.prefix + sid
    try {
      let data = await this.client.get(key)
      if (!data) return cb()
      return cb(null, await this.serializer.parse(data))
    } catch (err) {
      return cb(err)
    }
  }

  async set(sid: string, sess: UserSessionData, cb = noop) {
    let key = this.prefix + sid
    let userKey = this.prefixWOSeparator + sess.userId + this.separator + sid;
    let ttl = this._getTTL(sess)
    try {
      let val = this.serializer.stringify(sess)
      if (ttl > 0) {
        if (this.disableTTL) {
          await this.client.set(key, val)
          await this.client.set(userKey, key)
        } else {
          await this.client.set(key, val, ttl)
          await this.client.set(userKey, key, ttl)
        }
        return cb()
      } else {
        return this.destroy(sid, cb)
      }
    } catch (err) {
      return cb(err)
    }
  }

  async touch(sid: string, sess: UserSessionData, cb = noop) {
    let key = this.prefix + sid
    let userKey = this.prefixWOSeparator + sess.userId + this.separator + sid;
    if (this.disableTouch || this.disableTTL) return cb()
    try {
      const ttl = this._getTTL(sess)
      await this.client.expire(key, ttl)
      await this.client.expire(userKey, ttl)
      return cb()
    } catch (err) {
      return cb(err)
    }
  }

  async destroy(sid: string, cb = noop) {
    let key = this.prefix + sid
    try {
      const data = await this.client.get(key);
      if (data == null) return cb();
      const sess = await this.serializer.parse(data);
      const userKey = this.prefixWOSeparator + sess.userId + this.separator + sid;
      await this.client.del([key, userKey])
      return cb()
    } catch (err) {
      return cb(err)
    }
  }

  async clear(cb = noop) {
    try {
      let keys = await this._getAllKeys(true)
      if (!keys.length) return cb()
      await this.client.del(keys)
      return cb()
    } catch (err) {
      return cb(err)
    }
  }

  async clearForUser(uid: string, cb = noop) {
    try {
      let keys = await this._getUserKeys(uid)
      if (!keys.length) return cb()
      await this.client.del(keys)
      return cb()
    } catch (err) {
      return cb(err)
    }
  }

  async length(cb = noop) {
    try {
      let keys = await this._getAllKeys(false)
      return cb(null, keys.length)
    } catch (err) {
      return cb(err)
    }
  }

  async ids(cb = noop) {
    let len = this.prefix.length
    try {
      let keys = await this._getAllKeys(false)
      return cb(
        null,
        keys.map((k) => k.substring(len))
      )
    } catch (err) {
      return cb(err)
    }
  }

  async all(cb = noop) {
    let len = this.prefix.length
    try {
      let keys = await this._getAllKeys(false)
      if (keys.length === 0) return cb(null, [])

      let data = await this.client.mget(keys)
      let results = data.reduce((acc, raw, idx) => {
        if (!raw) return acc
        let sess = this.serializer.parse(raw) as any
        sess.id = keys[idx].substring(len)
        acc.push(sess)
        return acc
      }, [] as UserSessionData[])
      return cb(null, results)
    } catch (err) {
      return cb(err)
    }
  }

  private _getTTL(sess: UserSessionData) {
    if (typeof this.ttl === "function") {
      return this.ttl(sess)
    }

    let ttl
    if (sess && sess.cookie && sess.cookie.expires) {
      let ms = Number(new Date(sess.cookie.expires)) - Date.now()
      ttl = Math.ceil(ms / 1000)
    } else {
      ttl = this.ttl
    }
    return ttl
  }

  private async _getAllKeys(includeUserKeys = false) {
    let pattern = (includeUserKeys ? this.prefixWOSeparator : this.prefix) + "*"
    let keys = []
    for await (let key of this.client.scanIterator(pattern, this.scanCount)) {
      keys.push(key)
    }
    return keys
  }

  private async _getUserKeys(userId: string) {
    const userPrefix = this.prefixWOSeparator + userId + this.separator
    let pattern = userPrefix + "*"
    let keys = []
    for await (let key of this.client.scanIterator(pattern, this.scanCount)) {
      keys.push(key)
      keys.push(this.prefix + key.substring(userPrefix.length))
    }
    return keys
  }
}

export default RedisStore
