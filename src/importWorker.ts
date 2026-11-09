// entry worker thread untuk importBuild.runInWorker
import { parentPort, workerData } from 'node:worker_threads';
import { buildPlan, type BuildJob } from './importBuild';

parentPort!.postMessage(buildPlan(workerData as BuildJob));
