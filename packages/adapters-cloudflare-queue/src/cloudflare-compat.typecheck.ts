/// <reference types="@cloudflare/workers-types" />

import type { CloudflareQueue, ConnectorQueuePayload } from './producer.js';

declare const workersQueue: Queue<ConnectorQueuePayload>;
const structuralQueue: CloudflareQueue = workersQueue;
void structuralQueue;
