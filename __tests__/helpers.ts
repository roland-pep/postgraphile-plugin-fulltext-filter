// ----- Imports -----
import { Pool, PoolConfig } from "pg";
import { readFile } from "fs";
import pgConnectionString from "pg-connection-string";
import { createPostGraphileSchema } from "postgraphile-core";
import "dotenv/config";
import PostGraphileFulltextFilterPlugin from "../src/PostgraphileFullTextFilterPlugin";

// ----- Constants -----
jest.setTimeout(1000 * 20);

// ----- Utility Functions -----
function readFilePromise(filename, encoding) {
  return new Promise((resolve, reject) => {
    readFile(filename, encoding, (err, res) => {
      if (err) reject(err);
      else resolve(res);
    });
  });
}

export const loadQuery = (fn) =>
  readFilePromise(`${__dirname}/fixtures/queries/${fn}`, "utf8");

// ----- Database Connection and Setup Functions -----
export const withPgClient = async (urlOrFn, maybeFn?) => {
  const url = maybeFn ? urlOrFn : process.env.TEST_DATABASE_URL;
  const fn = maybeFn || urlOrFn;

  if (typeof fn !== "function") {
    throw new Error("Function argument is missing or not a function");
  }

  const connectionOptions = pgConnectionString.parse(url);
  const port = connectionOptions.port
    ? parseInt(connectionOptions.port, 10)
    : undefined;

  const poolConfig: PoolConfig = {
    user: connectionOptions.user,
    password: connectionOptions.password,
    host: connectionOptions.host,
    port: port,
    database: connectionOptions.database,
    ssl: {
      rejectUnauthorized: false, // For self-signed certificates; set to true if you have valid certificates
    },
  };

  const pgPool = new Pool(poolConfig);
  let client;

  try {
    client = await pgPool.connect();
    await client.query("begin");
    await client.query("set local timezone to '+04:00'");
    const result = await fn(client);
    await client.query("rollback");
    return result;
  } catch (error) {
    console.error(
      "Error during database operation",
      error instanceof Error ? error.message : error
    );
    throw error;
  } finally {
    try {
      if (client) {
        await client.release();
      }
    } catch (e) {
      console.error(
        "Error releasing pgClient",
        e instanceof Error ? e.message : e
      );
    }
    await pgPool.end();
  }
};

const withDbFromUrl = async (url, fn) =>
  withPgClient(url, async (client) => {
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE;");
      return fn(client);
    } finally {
      await client.query("COMMIT;");
    }
  });

export const withRootDb = (fn) =>
  withDbFromUrl(process.env.TEST_DATABASE_URL, fn);

let prepopulatedDBKeepalive;

const populateDatabase = async (client) => {
  try {
    const sql = await readFilePromise(`${__dirname}/schema.sql`, "utf8");

    await client.query(sql); // Execute SQL statements in data.sql
    return {};
  } catch (e) {
    console.error(
      "Error populating database",
      e instanceof Error ? e.message : e
    );
    throw e; // Rethrow the error to handle it in the calling function
  }
};

export const withPrepopulatedDb = async (fn) => {
  if (!prepopulatedDBKeepalive) {
    throw new Error("You must call setup and teardown to use this");
  }
  const { client, vars } = prepopulatedDBKeepalive;
  if (!vars) {
    throw new Error("No prepopulated vars");
  }
  let err;
  try {
    await fn(client, vars);
  } catch (e) {
    err = e;
  }
  try {
    await client.query("ROLLBACK TO SAVEPOINT pristine;");
  } catch (e) {
    err = err || e;
    console.error("ERROR ROLLING BACK", e instanceof Error ? e.message : e);
  }
  if (err) {
    throw err;
  }
};

withPrepopulatedDb.setup = (done) => {
  if (prepopulatedDBKeepalive) {
    throw new Error("There's already a prepopulated DB running");
  }

  prepopulatedDBKeepalive = new Promise((resolve, reject) => {
    prepopulatedDBKeepalive = { resolve, reject };
  });

  withRootDb(async (client) => {
    prepopulatedDBKeepalive.client = client;
    try {
      prepopulatedDBKeepalive.vars = await populateDatabase(client);
      await client.query("SAVEPOINT pristine;");
      done();
    } catch (e) {
      console.error(
        "FAILED TO PREPOPULATE DB!",
        e instanceof Error ? e.message : e
      );
      done(e);
    }
  });
};

// withPrepopulatedDb.teardown = () => {
//   if (!prepopulatedDBKeepalive) {
//     throw new Error("Cannot tear down null!");
//   }
//   prepopulatedDBKeepalive.resolve();
//   prepopulatedDBKeepalive = null;
// };

export const withSchema =
  ({ setup, test, options = {} }) =>
  () =>
    withPgClient(process.env.TEST_DATABASE_URL, async (client) => {
      try {
        await client.query("DROP SCHEMA IF EXISTS fulltext_test CASCADE;");
        await client.query("CREATE SCHEMA fulltext_test;");

        if (setup) {
          if (typeof setup === "function") {
            await setup(client);
          } else {
            await client.query("BEGIN"); // Start transaction
            await client.query(setup);
            await client.query("COMMIT"); // Commit changes
          }
        }

        const schemaOptions = {
          appendPlugins: [
            require("postgraphile-plugin-connection-filter"),
            PostGraphileFulltextFilterPlugin,
          ],
          showErrorStack: true,
          ...options,
        };

        const schema = await createPostGraphileSchema(
          client,
          ["fulltext_test"],
          schemaOptions
        );

        return test({
          schema,
          pgClient: client,
        });
      } catch (e) {
        console.error("Error during test", e instanceof Error ? e.message : e);
        throw e;
      }
    });
