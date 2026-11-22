'use strict';
// Parallel game runner (worker_threads). Jobs are plain JSON: { variant, lineup: [agentName], seed, maxRounds, settings }.
const { Worker, isMainThread, parentPort } = require('node:worker_threads');
const os = require('node:os');

if (!isMainThread) {
  const { runGame } = require('./harness');
  const { variants } = require('./agents');
  const extra = require('./skills').agents;
  const { V } = require('./variants');
  const agents = { ...variants, ...extra };
  parentPort.on('message', (jobs) => {
    const out = [];
    for (const j of jobs) {
      const r = runGame({
        seed: j.seed, maxRounds: j.maxRounds, settings: j.settings, variant: V[j.variant],
        agents: j.lineup.map((n) => { if (!agents[n]) throw new Error(`unknown agent ${n}`); return { name: n, decide: agents[n] }; }),
      });
      r.variant = j.variant; r.lineup = j.lineup; r.tag = j.tag;
      out.push(r);
    }
    parentPort.postMessage(out);
  });
}

function runJobs(jobs, threads = os.cpus().length) {
  const chunk = Math.max(1, Math.ceil(jobs.length / (threads * 6)));
  const batches = [];
  for (let k = 0; k < jobs.length; k += chunk) batches.push(jobs.slice(k, k + chunk));
  return new Promise((resolve, reject) => {
    const results = []; let next = 0; let live = 0;
    const workers = Array.from({ length: Math.min(threads, batches.length) }, () => new Worker(__filename));
    const feed = (w) => {
      if (next >= batches.length) { w.terminate(); if (--live === 0) resolve(results); return; }
      w.postMessage(batches[next++]);
    };
    for (const w of workers) {
      live++;
      w.on('message', (r) => { results.push(...r); feed(w); });
      w.on('error', reject);
      feed(w);
    }
  });
}

module.exports = { runJobs };
