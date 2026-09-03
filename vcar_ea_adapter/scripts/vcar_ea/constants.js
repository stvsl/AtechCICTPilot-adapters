/* EA 外部接口文档定义的固定 MQTT 连接参数。 */
export const BROKER_URI = "mqtt://127.0.0.1:11883";
export const MQTT_USERNAME = "VCarAPI";
export const MQTT_PASSWORD = "VCarAPI";
export const KEEP_ALIVE_SECONDS = 60;
export const CLIENT_PREFIX = "VCarEA_";
export const APPLICATION_NAME = "AtechCICTPilot";

export const TOPICS = Object.freeze({
    will: "KY/VCar/Will",
    pingRequest: "KY/VCar/Ping/Request",
    pingResponse: "KY/VCar/Ping/Response",
    output: "KY/VCar/Output",
    accessRequest: "KY/VCar/AccessInformation/Request",
    accessResponse: "KY/VCar/AccessInformation/Response",
    projectRequest: "KY/VCar/EA/ProjectManagement/Request",
    projectResponse: "KY/VCar/EA/ProjectManagement/Response",
    configurationsRequest: "KY/VCar/EA/Configurations/Request",
    configurationsResponse: "KY/VCar/EA/Configurations/Response",
    settingRequest: "KY/VCar/EA/SettingConfiguration/Request",
    settingResponse: "KY/VCar/EA/SettingConfiguration/Response",
    environmentRequest: "KY/VCar/EA/Environment/Request",
    environmentResponse: "KY/VCar/EA/Environment/Response",
    casesRequest: "KY/VCar/EA/Cases/Request",
    casesResponse: "KY/VCar/EA/Cases/Response",
    plansRequest: "KY/VCar/EA/Plans/Request",
    plansResponse: "KY/VCar/EA/Plans/Response",
    caseOperationRequest: "KY/VCar/EA/Case/Operation/Request",
    caseOperationResponse: "KY/VCar/EA/Case/Operation/Response",
    caseExecuteRequest: "KY/VCar/EA/Case/Execute/Request",
    caseExecuteResponse: "KY/VCar/EA/Case/Execute/Response",
    planOperationRequest: "KY/VCar/EA/Plan/Operation/Request",
    planOperationResponse: "KY/VCar/EA/Plan/Operation/Response",
    planExecuteRequest: "KY/VCar/EA/Plan/Execute/Request",
    planExecuteResponse: "KY/VCar/EA/Plan/Execute/Response",
    reportDownloadRequest: "KY/VCar/EA/Report/Download/Request",
    reportDownloadResponse: "KY/VCar/EA/Report/Download/Response",
    reportPushRequest: "KY/VCar/EA/Report/Push/Request",
    reportPushResponse: "KY/VCar/EA/Report/Push/Response",
    executionPortRequest: "KY/VCar/EA/Execution/MqttPort/Request",
    executionPortResponse: "KY/VCar/EA/Execution/MqttPort/Response",
    reportEvents: "VCar/EA/TestReport/#"
});

export const DEFAULT_RESPONSE_TIMEOUT_MS = 30000;
export const DEFAULT_EXECUTION_TIMEOUT_MS = 1800000;
export const DEFAULT_REPORT_TIMEOUT_MS = 600000;
export const RECEIVE_POLL_MS = 250;
export const MAX_PENDING_MESSAGES = 1024;
export const MAX_REPORT_PACKETS = 100000;
export const MAX_REPORT_BYTES = 512 * 1024 * 1024;
