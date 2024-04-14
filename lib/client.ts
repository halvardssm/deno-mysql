import {
  type Connection,
  ConnectionState,
  type ExecuteResult,
} from "./connection.ts";
import { ConnectionPool, PoolConnection } from "./pool.ts";
import { logger } from "./utils/logger.ts";
import { MysqlError } from "./utils/errors.ts";

/**
 * Client Config
 */
export interface ClientConfig {
  /** Database hostname */
  hostname?: string;
  /** Database UNIX domain socket path. When used, `hostname` and `port` are ignored. */
  socketPath?: string;
  /** Database username */
  username?: string;
  /** Database password */
  password?: string;
  /** Database port */
  port?: number;
  /** Database name */
  db?: string;
  /** Whether to display packet debugging information */
  debug?: boolean;
  /** Connection read timeout (default: 30 seconds) */
  timeout?: number;
  /** Connection pool size (default: 1) */
  poolSize?: number;
  /** Connection pool idle timeout in microseconds (default: 4 hours) */
  idleTimeout?: number;
  /** charset */
  charset?: string;
  /** tls config */
  tls?: TLSConfig;
}

export enum TLSMode {
  DISABLED = "disabled",
  VERIFY_IDENTITY = "verify_identity",
}
/**
 * TLS Config
 */
export interface TLSConfig {
  /** mode of tls. only support disabled and verify_identity now*/
  mode?: TLSMode;
  /** A list of root certificates (must be PEM format) that will be used in addition to the
   * default root certificates to verify the peer's certificate. */
  caCerts?: string[];
}

/** Transaction processor */
export interface TransactionProcessor<T> {
  (connection: Connection): Promise<T>;
}

/**
 * MySQL client
 */
export class Client {
  config: ClientConfig = {};
  private _pool?: ConnectionPool;

  private async createConnection(): Promise<PoolConnection> {
    let connection = new PoolConnection(this.config);
    await connection.connect();
    return connection;
  }

  /** get pool info */
  get pool() {
    return this._pool?.info;
  }

  /**
   * connect to database
   * @param config config for client
   * @returns Client instance
   */
  async connect(config: ClientConfig): Promise<Client> {
    this.config = {
      hostname: "127.0.0.1",
      username: "root",
      port: 3306,
      poolSize: 1,
      timeout: 30 * 1000,
      idleTimeout: 4 * 3600 * 1000,
      ...config,
    };
    Object.freeze(this.config);
    this._pool = new ConnectionPool(
      this.config.poolSize || 10,
      this.createConnection.bind(this),
    );
    return this;
  }

  /**
   * execute query sql
   * @param sql query sql string
   * @param params query params
   */
  async query(sql: string, params?: any[]): Promise<any> {
    return await this.useConnection(async (connection) => {
      return await connection.query(sql, params);
    });
  }

  /**
   * execute sql
   * @param sql sql string
   * @param params query params
   */
  async execute(sql: string, params?: any[]): Promise<ExecuteResult> {
    return await this.useConnection(async (connection) => {
      return await connection.execute(sql, params);
    });
  }

  async useConnection<T>(fn: (conn: Connection) => Promise<T>) {
    if (!this._pool) {
      throw new MysqlError("Unconnected");
    }
    const connection = await this._pool.pop();
    try {
      return await fn(connection);
    } finally {
      if (connection.state == ConnectionState.CLOSED) {
        connection.removeFromPool();
      } else {
        connection.returnToPool();
      }
    }
  }

  /**
   * Execute a transaction process, and the transaction successfully
   * returns the return value of the transaction process
   * @param processor transation processor
   */
  async transaction<T = any>(processor: TransactionProcessor<T>): Promise<T> {
    return await this.useConnection(async (connection) => {
      try {
        await connection.execute("BEGIN");
        const result = await processor(connection);
        await connection.execute("COMMIT");
        return result;
      } catch (error) {
        if (connection.state == ConnectionState.CONNECTED) {
          logger().info(`ROLLBACK: ${error.message}`);
          await connection.execute("ROLLBACK");
        }
        throw error;
      }
    });
  }

  /**
   * close connection
   */
  async close() {
    if (this._pool) {
      this._pool.close();
      this._pool = undefined;
    }
  }
}
