'use strict';
// Classifies whether two deliveries of one webhook were really processed concurrently.
//
// Same rules as the inline classification in test/scenarios/duplicate-captured.test.js, which is
// deliberately left unchanged (its baseline must not move). If one changes, review the other.
//
//   sequential    requested sequential delivery
//   concurrent    simultaneous: both requests overlapped at the server (arrival to response finish)
//                 barrier: barrier reached with both arrived and none finished, both finished after
//                 release, and the server intervals overlap
//   simultaneous_but_not_overlapping, barrier_not_verified   requested but not achieved
//
// `server` is the server-side trace for these two requests: [{ arrivedMs, finishedMs }, ...].
const { intervalsOverlap } = require('./delivery');

const VERIFIED = 'concurrent';

function serverOverlap(server) {
  return server.length === 2 && server.every((t) => t.finishedMs !== undefined)
    && intervalsOverlap({ start: server[0].arrivedMs, end: server[0].finishedMs }, { start: server[1].arrivedMs, end: server[1].finishedMs });
}

function classifyDelivery(mode, delivery, server) {
  const overlap = serverOverlap(server);
  let classification = 'sequential';
  if (mode === 'simultaneous') classification = overlap ? VERIFIED : 'simultaneous_but_not_overlapping';
  if (mode === 'barrier') {
    const b = delivery.barrier;
    const releasedBeforeFinish = Boolean(b) && server.length === 2 && server.every((t) => t.finishedMs > b.releasedAtMs);
    const verified = Boolean(b?.reached) && b.arrivedAtRelease === 2 && b.finishedAtRelease === 0 && releasedBeforeFinish && overlap;
    classification = verified ? VERIFIED : 'barrier_not_verified';
  }
  return {
    mode,
    classification,
    verified: classification === VERIFIED,
    serverOverlap: overlap,
    clientOverlap: delivery.clientOverlap,
    barrier: delivery.barrier ?? null,
    server,
  };
}

module.exports = { classifyDelivery, serverOverlap, VERIFIED };
