# DLL 包装函数库

本目录由 DLL 接入工作台生成，配置来源为 `bindings.json`。
修改配置后重新生成；生成文件不使用绝对开发机路径。

JavaScript：`import {openLibrary} from "./connector_sdk/index.js";`
Python：`from .connector_sdk import open_library`，支持 `with open_library() as sdk:`。
默认库 URI：`plugin://dll/KY.VCar.Central.Connector.Sdk.dll`，可向打开函数传入实际安装路径。

接口使用配置中的别名作为具名函数；参数按签名顺序传入，最后可传 options。
Python 的 options 是关键字参数，JavaScript 的 options 是最后一个参数。
Native 的 out 参数自动分配；有出参或 inout 时返回 `{value, out}`。
.NET 构造函数及声明了实例方法的返回类型自动包装为具名对象。
close 释放句柄；需要执行 SDK 的 Dispose 等业务方法时显式调用对应具名函数。
库关闭会释放尚未关闭的对象，后续调用会报错。错误与取消沿用运行时行为。

包装库复用 atech 运行时与隔离 worker。插件清单仍需声明所用运行时和 DLL 权限；
把第三方库及依赖放到默认 URI 对应位置，或传入已授权的本地路径。
