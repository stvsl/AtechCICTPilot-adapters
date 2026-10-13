// 由 DLL 工作台生成；修改 bindings.json 后重新生成，勿手改本文件。
import * as _dll from "@atech/dllnet";
const configuration = JSON.parse("{\"aliases\":{\"Connect\":{\"kind\":\"staticMethod\",\"member\":\"Connect\",\"parameterTypes\":[\"KY.VCar.Central.Connector.Sdk.ConnectorServiceOptions\"],\"returnType\":\"KY.VCar.Central.Connector.Sdk.ConnectorServiceClient\",\"type\":\"KY.VCar.Central.Connector.Sdk.ConnectorServiceClient\"},\"Dispose\":{\"kind\":\"method\",\"member\":\"Dispose\",\"parameterTypes\":[],\"returnType\":\"System.Void\",\"type\":\"KY.VCar.Central.Connector.Sdk.ConnectorServiceClient\"},\"TryGetConnectionInfo\":{\"kind\":\"method\",\"member\":\"TryGetConnectionInfo\",\"parameterTypes\":[\"System.String\"],\"returnType\":\"System.Object\",\"type\":\"KY.VCar.Central.Connector.Sdk.ConnectorServiceClient\"}},\"architecture\":\"any\",\"schema\":\"atech.dllnet\",\"version\":1}");
export function openLibrary(path = "plugin://dll/KY.VCar.Central.Connector.Sdk.dll") {
  const library = _dll.load(path, {config: configuration});
  const objects = new Set();
  let closed = false;
  function ensureOpen() {
    if (closed) throw new Error("库已关闭");
  }
  function close() {
    if (closed) return;
    closed = true;
    let failure = null;
    for (const handle of objects) {
      try { handle.close(); } catch (error) { if (failure === null) failure = error; }
    }
    objects.clear();
    try { library.close(); } catch (error) { if (failure === null) failure = error; }
    if (failure !== null) throw failure;
  }
  function wrap0(handle) {
    if (handle === null || handle === undefined) return null;
    objects.add(handle);
    let objectClosed = false;
    return {
      close() {
        if (objectClosed) return;
        objectClosed = true;
        objects.delete(handle);
        if (!closed) handle.close();
      },
      Dispose(options = {}) {
        ensureOpen();
        if (objectClosed) throw new Error("对象已关闭");
        const _result = handle.call("Dispose", [], options);
        return _result;
      },
      TryGetConnectionInfo(arg1, options = {}) {
        ensureOpen();
        if (objectClosed) throw new Error("对象已关闭");
        const _result = handle.call("TryGetConnectionInfo", [arg1], options);
        return _result;
      },
    };
  }
  return {
      close,
      Connect(arg1, options = {}) {
        ensureOpen();
        const _result = library.callObject("Connect", [arg1], options);
        return wrap0(_result);
      },
  };
}
