# 由 DLL 工作台生成；修改 bindings.json 后重新生成，勿手改本文件。
import json as _json
from atech import dllnet as _dll
_configuration = _json.loads("{\"aliases\":{\"Connect\":{\"kind\":\"staticMethod\",\"member\":\"Connect\",\"parameterTypes\":[\"KY.VCar.Central.Connector.Sdk.ConnectorServiceOptions\"],\"returnType\":\"KY.VCar.Central.Connector.Sdk.ConnectorServiceClient\",\"type\":\"KY.VCar.Central.Connector.Sdk.ConnectorServiceClient\"},\"Dispose\":{\"kind\":\"method\",\"member\":\"Dispose\",\"parameterTypes\":[],\"returnType\":\"System.Void\",\"type\":\"KY.VCar.Central.Connector.Sdk.ConnectorServiceClient\"},\"TryGetConnectionInfo\":{\"kind\":\"method\",\"member\":\"TryGetConnectionInfo\",\"parameterTypes\":[\"System.String\"],\"returnType\":\"System.Object\",\"type\":\"KY.VCar.Central.Connector.Sdk.ConnectorServiceClient\"}},\"architecture\":\"any\",\"schema\":\"atech.dllnet\",\"version\":1}")

def open_library(path="plugin://dll/KY.VCar.Central.Connector.Sdk.dll"):
    return _Library(path)

class _Library:
    def __init__(self, path):
        self._library = _dll.load(path, _configuration)
        self._objects = []
        self._closed = False

    def _ensure_open(self):
        if self._closed:
            raise RuntimeError("库已关闭")

    def __enter__(self):
        self._ensure_open()
        return self

    def __exit__(self, exc_type, exc, traceback):
        if exc_type is None:
            self.close()
        else:
            try:
                self.close()
            except Exception:
                pass
        return False

    def close(self):
        if self._closed:
            return
        self._closed = True
        failure = None
        for handle in self._objects:
            try:
                handle.close()
            except Exception as error:
                if failure is None:
                    failure = error
        self._objects.clear()
        try:
            self._library.close()
        except Exception as error:
            if failure is None:
                failure = error
        if failure is not None:
            raise failure

    def Connect(self, arg1, *, options=None):
        self._ensure_open()
        _result = self._library.call_object("Connect", [arg1], options)
        return None if _result is None else _Object0(self, _result)

class _Object0:
    def __init__(self, owner, handle):
        self._owner = owner
        self._handle = handle
        self._closed = False
        owner._objects.append(handle)

    def __enter__(self):
        self._owner._ensure_open()
        if self._closed:
            raise RuntimeError("对象已关闭")
        return self

    def __exit__(self, exc_type, exc, traceback):
        if exc_type is None:
            self.close()
        else:
            try:
                self.close()
            except Exception:
                pass
        return False

    def close(self):
        if self._closed:
            return
        self._closed = True
        if self._handle in self._owner._objects:
            self._owner._objects.remove(self._handle)
        if not self._owner._closed:
            self._handle.close()

    def Dispose(self, *, options=None):
        self._owner._ensure_open()
        if self._closed:
            raise RuntimeError("对象已关闭")
        _result = self._handle.call("Dispose", [], options)
        return _result

    def TryGetConnectionInfo(self, arg1, *, options=None):
        self._owner._ensure_open()
        if self._closed:
            raise RuntimeError("对象已关闭")
        _result = self._handle.call("TryGetConnectionInfo", [arg1], options)
        return _result

