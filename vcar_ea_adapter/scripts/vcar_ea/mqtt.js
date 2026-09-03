import * as mqtt from "@atech/mqtt";
import * as task from "@atech/task";

import {
    APPLICATION_NAME,
    BROKER_URI,
    DEFAULT_RESPONSE_TIMEOUT_MS,
    KEEP_ALIVE_SECONDS,
    MQTT_PASSWORD,
    MQTT_USERNAME,
    RECEIVE_POLL_MS,
    TOPICS
} from "./constants.js";
import { encodeUtf8, jsonBytes, parseJsonBytes } from "./codec.js";
import { requireExecutionContext } from "./state.js";

function optionInteger(name, fallback, minimum, maximum) {
    const raw = task.option(name, fallback);
    const value = Number(raw);
    if (!Number.isFinite(value) || !Number.isInteger(value)
            || value < minimum || value > maximum) {
        throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
    }
    return value;
}

function optionString(name, fallback) {
    const value = task.option(name, fallback);
    return value === undefined || value === null ? fallback : String(value);
}

function requireConnected(context) {
    if (context.handle === null) {
        throw new Error("VCarEA MQTT connection is not established");
    }
    if (!mqtt.isConnected(context.handle)) {
        throw new Error("VCarEA MQTT connection was lost");
    }
}

function takeMessage(context, timeoutMs) {
    return mqtt.receive(context.handle, timeoutMs);
}

function messagePayload(message) {
    return message && message.payload !== undefined
        ? message.payload : new Uint8Array(0);
}

function routeUnmatchedMessage(context, message) {
    if (message.topic.startsWith("VCar/EA/TestReport/")) {
        try {
            const event = parseJsonBytes(messagePayload(message), "EA report event");
            task.info(`EA report event ${event.ID || ""} (code ${event.Code || 0})`);
        } catch (_) {
            task.info(`EA report event received on ${message.topic}`);
        }
        return;
    }
}

export function responseTimeout() {
    return optionInteger("ResponseTimeoutMs",
                         DEFAULT_RESPONSE_TIMEOUT_MS,
                         1,
                         1800000);
}

export function executionTimeout() {
    return optionInteger("ExecutionTimeoutMs", 1800000, 1, 86400000);
}

export function reportTimeout() {
    return optionInteger("ReportTimeoutMs", 600000, 1, 86400000);
}

export function connectAndSubscribe() {
    const context = requireExecutionContext();
    if (context.handle !== null) {
        requireConnected(context);
        return;
    }
    const will = {
        ID: `${context.clientId}-will`,
        ClientID: context.clientId,
        Data: {AppName: APPLICATION_NAME}
    };
    const connection = mqtt.connect({
        serverUri: BROKER_URI,
        clientId: context.clientId,
        username: MQTT_USERNAME,
        password: encodeUtf8(MQTT_PASSWORD),
        keepAliveSeconds: KEEP_ALIVE_SECONDS,
        connectTimeoutMs: optionInteger("ConnectTimeoutMs", 10000, 1, 120000),
        cleanSession: true,
        cleanStart: true,
        will: {
            topic: TOPICS.will,
            payload: jsonBytes(will),
            qos: 1,
            retained: false
        }
    });
    context.handle = connection.handle;
    const responseTopics = [
        TOPICS.pingResponse,
        TOPICS.accessResponse,
        TOPICS.projectResponse,
        TOPICS.configurationsResponse,
        TOPICS.settingResponse,
        TOPICS.environmentResponse,
        TOPICS.casesResponse,
        TOPICS.plansResponse,
        TOPICS.caseOperationResponse,
        TOPICS.caseExecuteResponse,
        TOPICS.planOperationResponse,
        TOPICS.planExecuteResponse,
        TOPICS.reportDownloadResponse,
        TOPICS.reportPushResponse,
        TOPICS.executionPortResponse,
        TOPICS.reportEvents
    ];
    for (const topic of responseTopics) {
        mqtt.subscribe(context.handle, topic, 1);
        context.subscriptions.push(topic);
    }
    task.info(`Connected to VCarEA MQTT as ${context.clientId}`);
}

export function publishJson(topic, value, qos = 1) {
    const context = requireExecutionContext();
    requireConnected(context);
    mqtt.publish(context.handle, {
        topic,
        payload: jsonBytes(value),
        qos,
        retained: false
    });
}

export function baseRequest(data) {
    const context = requireExecutionContext();
    const request = {
        ID: `${context.clientId}-${Date.now()}-${Math.floor(Math.random() * 1000000)}`,
        ClientID: context.clientId,
        Data: data
    };
    const targetClientId = optionString("TargetClientID", "").trim();
    if (targetClientId.length > 0) {
        request.TargetClientID = targetClientId;
    }
    const broadcast = task.option("IsBroadcast", undefined);
    if (broadcast !== undefined && broadcast !== null) {
        request.IsBroadcast = Boolean(broadcast);
    }
    return request;
}

export function waitForResponse(responseTopic, requestId, timeoutMs = responseTimeout()) {
    const context = requireExecutionContext();
    requireConnected(context);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        task.checkCancelled();
        const remaining = Math.max(1, Math.min(RECEIVE_POLL_MS, deadline - Date.now()));
        const message = takeMessage(context, remaining);
        if (message === null || message === undefined) {
            continue;
        }
        if (message.topic !== responseTopic) {
            routeUnmatchedMessage(context, message);
            continue;
        }
        let response;
        try {
            response = parseJsonBytes(messagePayload(message), "EA response");
        } catch (error) {
            throw new Error(`Unable to decode EA response: ${error.message}`);
        }
        if (String(response.ID || "") !== String(requestId)) {
            routeUnmatchedMessage(context, message);
            continue;
        }
        const code = Number(response.Code);
        if (!Number.isInteger(code)) {
            throw new Error(`EA response ${requestId} has an invalid Code`);
        }
        if (code !== 0) {
            throw new Error(`EA request ${requestId} failed with code ${code}: ${response.Msg || ""}`);
        }
        return response;
    }
    throw new Error(`Timed out waiting for EA response ${responseTopic} (${requestId})`);
}

export function request(requestTopic, responseTopic, data, timeoutMs = responseTimeout()) {
    const request = baseRequest(data);
    publishJson(requestTopic, request);
    return waitForResponse(responseTopic, request.ID, timeoutMs);
}

export function receiveMessage(timeoutMs) {
    const context = requireExecutionContext();
    requireConnected(context);
    return takeMessage(context, timeoutMs);
}

export function subscribe(topic, qos = 1) {
    const context = requireExecutionContext();
    requireConnected(context);
    if (context.subscriptions.indexOf(topic) < 0) {
        mqtt.subscribe(context.handle, topic, qos);
        context.subscriptions.push(topic);
    }
}

export function unsubscribe(topic) {
    const context = requireExecutionContext();
    if (context.handle === null) {
        return;
    }
    if (context.subscriptions.indexOf(topic) >= 0) {
        mqtt.unsubscribe(context.handle, topic);
        context.subscriptions = context.subscriptions.filter((value) => value !== topic);
    }
}

export function disconnect() {
    const context = requireExecutionContext();
    if (context.handle === null) {
        return;
    }
    try {
        mqtt.disconnect(context.handle, 5000);
    } finally {
        context.handle = null;
        context.subscriptions = [];
    }
}
