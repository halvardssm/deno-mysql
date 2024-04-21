import {
  SqlxBase,
  type SqlxClientPool,
  type SqlxClientPoolOptions,
  type SqlxConnectionOptions,
  SqlxDeferredStack,
  SqlxError,
  type SqlxPoolClient,
} from "@halvardm/sqlx";
import {
  type MysqlPrepared,
  type MysqlQueryOptions,
  type MySqlTransaction,
  MysqlTransactionable,
  type MysqlTransactionOptions,
} from "./client.ts";
import { MysqlConnection, type MysqlConnectionOptions } from "./connection.ts";
import type { MysqlParameterType } from "./packets/parsers/result.ts";
import {
  MysqlConnectionCloseEvent,
  MysqlConnectionConnectEvent,
  MysqlPoolConnectionAcquireEvent,
  MysqlPoolConnectionDestroyEvent,
  MysqlPoolConnectionReleaseEvent,
} from "./utils/events.ts";
import { logger } from "./utils/logger.ts";
import { MysqlEventTarget } from "./utils/events.ts";

export interface MysqlClientPoolOptions
  extends MysqlConnectionOptions, SqlxClientPoolOptions {
}

export class MysqlPoolClient extends MysqlTransactionable
  implements
    SqlxPoolClient<
      MysqlEventTarget,
      MysqlConnectionOptions,
      MysqlConnection,
      MysqlParameterType,
      MysqlQueryOptions,
      MysqlPrepared,
      MysqlTransactionOptions,
      MySqlTransaction
    > {
  /**
   * Must be set by the client pool on creation
   * @inheritdoc
   */
  release(): Promise<void> {
    throw new Error("Method not implemented.");
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.release();
  }
}

export class MysqlClientPool extends SqlxBase implements
  SqlxClientPool<
    MysqlEventTarget,
    MysqlConnectionOptions,
    MysqlConnection,
    MysqlParameterType,
    MysqlQueryOptions,
    MysqlPrepared,
    MysqlTransactionOptions,
    MySqlTransaction,
    MysqlPoolClient,
    SqlxDeferredStack<MysqlPoolClient>
  > {
  readonly connectionUrl: string;
  readonly connectionOptions: SqlxConnectionOptions;
  readonly eventTarget: EventTarget;
  readonly deferredStack: SqlxDeferredStack<MysqlPoolClient>;
  readonly queryOptions: MysqlQueryOptions;

  #connected: boolean = false;

  get connected(): boolean {
    return this.#connected;
  }

  constructor(
    connectionUrl: string | URL,
    connectionOptions: MysqlClientPoolOptions = {},
  ) {
    super();
    this.connectionUrl = connectionUrl.toString();
    this.connectionOptions = connectionOptions;
    this.queryOptions = connectionOptions;
    this.eventTarget = new MysqlEventTarget();
    this.deferredStack = new SqlxDeferredStack<MysqlPoolClient>(
      connectionOptions,
    );
  }

  async connect(): Promise<void> {
    for (let i = 0; i < this.deferredStack.maxSize; i++) {
      const conn = new MysqlConnection(
        this.connectionUrl,
        this.connectionOptions,
      );
      const client = new MysqlPoolClient(
        conn,
        this.queryOptions,
      );
      client.release = () => this.release(client);

      if (!this.connectionOptions.lazyInitialization) {
        await client.connection.connect();
        this.eventTarget.dispatchEvent(
          new MysqlConnectionConnectEvent({ connectable: client }),
        );
      }

      this.deferredStack.push(client);
    }

    this.#connected = true;
  }

  async close(): Promise<void> {
    this.#connected = false;

    for (const client of this.deferredStack.elements) {
      this.eventTarget.dispatchEvent(
        new MysqlConnectionCloseEvent({ connectable: client }),
      );
      await client.connection.close();
    }
  }

  async acquire(): Promise<MysqlPoolClient> {
    const client = await this.deferredStack.pop();

    this.eventTarget.dispatchEvent(
      new MysqlPoolConnectionAcquireEvent({ connectable: client }),
    );
    return client;
  }

  async release(client: MysqlPoolClient): Promise<void> {
    this.eventTarget.dispatchEvent(
      new MysqlPoolConnectionReleaseEvent({ connectable: client }),
    );
    try {
      this.deferredStack.push(client);
    } catch (e) {
      if (e instanceof SqlxError && e.message === "Max pool size reached") {
        logger().debug(e.message);
        await client.connection.close();
        throw e;
      } else {
        throw e;
      }
    }
  }

  async destroy(client: MysqlPoolClient): Promise<void> {
    this.eventTarget.dispatchEvent(
      new MysqlPoolConnectionDestroyEvent({ connectable: client }),
    );
    await client.connection.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
