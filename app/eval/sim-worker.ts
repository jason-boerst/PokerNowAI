// Worker thread for simulateParallel: installs the pool model, plays its share of hands, posts the result.
import { parentPort, workerData } from "node:worker_threads";
import { simulate, SimOptions, usePool, PoolModel } from "./simulate.ts";

const { pool, options } = workerData as { pool: PoolModel, options: SimOptions };
usePool(pool);
parentPort!.postMessage(simulate(options));
