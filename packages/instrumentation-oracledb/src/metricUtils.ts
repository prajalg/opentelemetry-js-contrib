/*
 * Copyright The OpenTelemetry Authors
 * Copyright (c) 2025, 2026, Oracle and/or its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Attributes,
  Counter,
  Histogram,
  HrTime,
  Meter,
  UpDownCounter,
} from '@opentelemetry/api';
import {
  hrTime,
  hrTimeDuration,
  hrTimeToMilliseconds,
} from '@opentelemetry/core';
import { METRIC_DB_CLIENT_OPERATION_DURATION } from '@opentelemetry/semantic-conventions';
import * as oracleDBTypes from 'oracledb';
import {
  ATTR_DB_CLIENT_CONNECTION_POOL_NAME,
  ATTR_DB_CLIENT_CONNECTION_STATE,
  DB_CLIENT_CONNECTION_STATE_VALUE_IDLE,
  DB_CLIENT_CONNECTION_STATE_VALUE_USED,
  METRIC_DB_CLIENT_CONNECTION_COUNT,
  METRIC_DB_CLIENT_CONNECTION_PENDING_REQUESTS,
  METRIC_DB_CLIENT_CONNECTION_TIMEOUTS,
} from './semconv';

let operationDuration!: Histogram;
let connectionsCount!: UpDownCounter;
let connectionPendingRequests!: UpDownCounter;
let connectionsTimeouts!: Counter;
const connectionsCounterState: Record<string, PoolConnectionsCounter> = {};

export interface PoolConnectionsCounter {
  idle: number;
  pending: number;
  used: number;
  timeouts: number;
}

// To be discussed
export function getPoolName(
  pool: oracleDBTypes.Pool & { connectString?: string }
): string {
  return pool.poolAlias?.trim() || pool.connectString!.trim();
}

export function setMetricInstruments(meter: Meter) {
  connectionsCount = meter.createUpDownCounter(
    METRIC_DB_CLIENT_CONNECTION_COUNT,
    {
      description:
        'The number of connections that are currently in state described by the state attribute.',
      unit: '{connection}',
    }
  );

  connectionPendingRequests = meter.createUpDownCounter(
    METRIC_DB_CLIENT_CONNECTION_PENDING_REQUESTS,
    {
      description:
        'The number of current pending requests for an open connection.',
      unit: '{request}',
    }
  );

  connectionsTimeouts = meter.createCounter(
    METRIC_DB_CLIENT_CONNECTION_TIMEOUTS,
    {
      description:
        'The number of connection timeouts that have occurred trying to obtain a connection from the pool.',
      unit: '{timeout}',
    }
  );

  operationDuration = meter.createHistogram(
    METRIC_DB_CLIENT_OPERATION_DURATION,
    {
      description: 'Duration of database client operations.',
      unit: 's',
      valueType: 1,
      advice: {
        explicitBucketBoundaries: [
          0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10,
        ],
      },
    }
  );

  for (const pool in connectionsCounterState) {
    connectionsCounterState[pool] = {
      used: 0,
      idle: 0,
      pending: 0,
      timeouts: 0,
    };
  }
}

export function updateCounter(pool: oracleDBTypes.Pool) {
  if (!pool) return;

  const poolName = getPoolName(pool);
  const prev = connectionsCounterState[poolName] || {
    idle: 0,
    used: 0,
    pending: 0,
    timeouts: 0,
  };

  const isOpen = pool.status === oracleDBTypes.POOL_STATUS_OPEN;
  const statistics = isOpen ? pool.getStatistics?.() : undefined;

  const curr: PoolConnectionsCounter = isOpen
    ? {
        used: pool.connectionsInUse,
        idle: pool.connectionsOpen - pool.connectionsInUse,
        pending: statistics?.currentQueueLength ?? 0,
        timeouts: statistics?.requestTimeouts ?? 0,
      }
    : { used: 0, idle: 0, pending: 0, timeouts: 0 };

  // all delta calculation at once
  const delta = {
    used: curr.used - prev.used,
    idle: curr.idle - prev.idle,
    pending: curr.pending - prev.pending,
    timeouts: Math.max(curr.timeouts - prev.timeouts, 0),
  };

  const poolAttr = { [ATTR_DB_CLIENT_CONNECTION_POOL_NAME]: poolName };

  // apply deltas & update counters
  connectionsCount.add(delta.used, {
    ...poolAttr,
    [ATTR_DB_CLIENT_CONNECTION_STATE]: DB_CLIENT_CONNECTION_STATE_VALUE_USED,
  });

  connectionsCount.add(delta.idle, {
    ...poolAttr,
    [ATTR_DB_CLIENT_CONNECTION_STATE]: DB_CLIENT_CONNECTION_STATE_VALUE_IDLE,
  });

  connectionPendingRequests.add(delta.pending, poolAttr);

  connectionsTimeouts.add(delta.timeouts, poolAttr);

  if (isOpen) {
    connectionsCounterState[poolName] = curr;
  } else {
    delete connectionsCounterState[poolName];
  }
}

export function recordOperationDuration(
  metricsAttributes: Attributes,
  startExecTime: HrTime
) {
  const durationSeconds =
    hrTimeToMilliseconds(hrTimeDuration(startExecTime, hrTime())) / 1000;
  operationDuration.record(durationSeconds, metricsAttributes);
}
