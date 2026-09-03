# EA外部调用接口

## 1. 概述

EA提供一套可以外部调用的远程调用接口，其中包含EA软件的实验环境启动、Plan和Case的执行，以及其他的相关配置接口。

接口中使用的上层应用协议为：**mqtt v3.1.1协议**，接口调用采用主题发布订阅方式实现。

接口中使用的数据传递格式为：**UTF-8编码的Json数据格式**。

### 1.1 通用数据结构

定义本套接口中使用的通用数据结构定义。

#### 1.1.1 请求通用字段

| 字段           | 必填 | 说明                                                                   |
| -------------- | ---- | ---------------------------------------------------------------------- |
| ID             | 是   | 消息ID，标识本条消息的唯一ID，同时该ID的请求ID与应答ID是相同的         |
| ClientID       | 是   | 登录Mqtt时上传的Mqtt Client ID                                         |
| TargetClientID | 否   | 目标Mqtt的Client ID                                                    |
| IsBroadcast    | 否   | 是否为广播消息，默认为广播消息                                         |
| Data           | 否   | 数据，该字段根据应答的内容关联，不同的接口应答的消息内容存在一定的差异 |

#### 1.1.2 应答通用字段

| 字段           | 必填 | 说明                                                                     |
| -------------- | ---- | ------------------------------------------------------------------------ |
| ID             | 是   | 消息ID，标识本条消息的唯一ID，同时该ID的请求ID与应答ID是相同的           |
| Code           | 是   | 状态代码，该字段为接口中应答时对应的状态代码，详细信息可参考状态代码章节 |
| Msg            | 是   | 消息内容，该内容不建议作为操作状态判定依据                               |
| ClientID       | 是   | 接口被调用者登录Mqtt时上传的Mqtt Client ID                               |
| TargetClientID | 否   | 目标Mqtt的Client ID                                                      |
| IsBroadcast    | 否   | 是否为广播消息，默认为广播消息                                           |
| Data           | 否   | 数据，该字段根据应答的内容关联，不同的接口应答的消息内容存在一定的差异   |

#### 1.1.3 Mqtt Client ID生成建议

创建Mqtt Client ID时建议生成规则为：程序进程名称 + 16个字节长度的GUID组成一组ID。

如：`VCarEA_d35416b9-5ecb-42af-a4ce-fc514f216da4`

## 2. 基础接口

### 2.1 mqtt服务连接

调用接口之前需要进行mqtt服务连接，mqtt服务连接方式如下：

| 项目     | 值               |
| -------- | ---------------- |
| 连接地址 | mqtt://127.0.0.1 |
| 连接端口 | 11883            |
| 用户名   | VCarAPI          |
| 密码     | VCarAPI          |
| 心跳周期 | 60秒             |

### 2.2 遗嘱主题

连接mqtt连接后，需要配置有遗嘱主题，实现断开时通知对应客户端或服务端连接已断开。

- 信息接入主题：`KY/VCar/Will`

请求消息：

```json
{
  "ID": "123", // 消息ID，标识本条消息的唯一ID，消息应答时答复的ID
  "ClientID": "adfaadf-adfad12323-adfadfadf", // 登录mqtt服务时注册的ID
  "Data": {
    "AppName": "test.exe"
  }
}
```

### 2.3 Ping接口

- 请求主题：`KY/VCar/Ping/Request`

请求消息：

```json
{
  "ID": "123", // 消息ID，标识本条消息的唯一ID，消息应答时答复的ID
  "ClientID": "adfaadf-adfad12323-adfadfadf", // 登录mqtt服务时注册的ID
  "Data": {
    "AppName": "test.exe"
  }
}
```

- 应答主题：`KY/VCar/Ping/Response`

应答消息：

```json
{
  "ID": "123", // 请求接入时的消息ID
  "Code": 0, // 状态代码
  "Msg": "succeed", // 消息内容
  "ClientID": "adfaadf-adfad12323-adfadfadf",
  "Data": {
    "AppName": "test.exe" // 因该接口为通用接口，收到的进程都会应答，需要识别此字段区分应答者进程
  }
}
```

### 2.4 Output打印信息接口

可以通过接口在Output窗口输出信息。

- 信息接入主题：`KY/VCar/Output`

请求消息：

```json
{
  "ID": "123", // 消息ID，标识本条消息的唯一ID，消息应答时答复的ID
  "ClientID": "adfaadf-adfad12323-adfadfadf", // 登录mqtt服务时注册的ID
  "Data": {
    "Target": "VCarEA", // 接入目标，VCarEA接口固定为VCarEA
    "MsgSource": "TestApi",
    "Msg": "输出一条消息", // 打印消息内容
    "MsgType": 0 // 消息类型，0：错误信息，1：警告信息；2：普通消息；3：自定义消息
  }
}
```

### 2.5 API接入信息接口

登录完成mqtt服务后，需要发布信息接入主题通知EA，当前有外部应用需要接入EA API接口。

- 请求主题：`KY/VCar/AccessInformation/Request`

请求消息：

```json
{
  "ID": "123", // 消息ID，标识本条消息的唯一ID，消息应答时答复的ID
  "ClientID": "adfaadf-adfad12323-adfadfadf", // 登录mqtt服务时注册的ID
  "Data": {
    "AccessAPPName": "test.exe", // 接入软件名称
    "Target": "VCarEA" // 接入目标，VCarEA接口固定为VCarEA
  }
}
```

- 应答主题：`KY/VCar/AccessInformation/Response`

应答消息：

```json
{
  "ID": "123", // 请求接入时的消息ID
  "Code": 0, // 状态代码
  "Msg": "succeed", // 消息内容
  "ClientID": "adfaadf-adfad12323-adfadfadf"
}
```

## 3. 业务接口

### 3.1 关闭、打开、查询项目

可通过接口控制EA打开指定项目，或关闭当前项目。同时，当操作类型为`1`，项目打开成功，可从返回数据中获取项目中的tcf、tbf文件以及对应的case和plan文件列表。

> 注：按原文描述，`OperationType`中`0`为打开项目、`1`为关闭项目；可从项目打开成功的返回数据中获取文件列表。

- 请求主题：`KY/VCar/EA/ProjectManagement/Request`

请求消息：

```json
{
  "ID": "123", // 消息ID，标识本条消息的唯一ID，消息应答时答复的ID
  "ClientID": "adfaadf-adfad12323-adfadfadf", // 登录mqtt服务时注册的ID
  "Data": {
    "OperationType": 1, // 操作类型 0：打开项目，1：关闭项目，2：查询已打开项目，3：刷新项目目录
    "ProjectPath": "E:\\Project\\VCarEA\\Autotest\\test.hlt", // 项目路径
    "ConstaraintUpdate": true // 是否强制更新case
  }
}
```

- 应答主题：`KY/VCar/EA/ProjectManagement/Response`

应答消息：

```json
{
  "ID": "123", // 请求接入时的消息ID
  "Code": 0, // 状态代码
  "Msg": "succeed", // 消息内容
  "ClientID": "adfaadf-adfad12323-adfadfadf",
  "Data": {
    "Configurations": [
      {
        "Type": "tbf", // 文件类型
        "Path": "VCarEA\\Configurations\\Testbench.tbf" // 文件路径
      },
      {
        "Type": "tcf",
        "Path": "VCarEA\\Configurations\\Test.tcf"
      }
    ],
    "Cases": [
      {
        "Type": "case", // 文件类型
        "Path": "VCarEA\\cases\\ccc.case" // 文件路径
      },
      {
        "Type": "case",
        "Path": "VCarEA\\cases\\ccc.case"
      }
    ],
    "Plans": [
      {
        "Type": "plan", // 文件类型
        "Path": "VCarEA\\plans\\ccc.plan" // 文件路径
      },
      {
        "Type": "case",
        "Path": "VCarEA\\plans\\ccc.plan"
      }
    ]
  }
}
```

### 3.2 获取配置列表

通过该项接口可以获取EA项目中的Configurations节点列表。

- 请求主题：`KY/VCar/EA/Configurations/Request`

请求消息：

```json
{
  "ID": "123", // 消息ID，标识本条消息的唯一ID，消息应答时答复的ID
  "ClientID": "adfaadf-adfad12323-adfadfadf" // 登录mqtt服务时注册的ID
}
```

- 应答主题：`KY/VCar/EA/Configurations/Response`

应答消息：

```json
{
  "ID": "123", // 请求接入时的消息ID
  "Code": 0, // 状态代码
  "Msg": "succeed", // 消息内容
  "ClientID": "adfaadf-adfad12323-adfadfadf",
  "Data": [
    {
      "Type": "tbf", // 文件类型
      "Path": "VCarEA\\Configurations\\Testbench.tbf" // 文件路径
    },
    {
      "Type": "tcf",
      "Path": "VCarEA\\Configurations\\Test.tcf"
    }
  ]
}
```

### 3.3 启动配置

通过该项接口完成测试台的配置，可通过该接口给测试台配置tcf和tbf文件。

- 请求主题：`KY/VCar/EA/SettingConfiguration/Request`

请求消息：

```json
{
  "ID": "123", // 消息ID，标识本条消息的唯一ID，消息应答时答复的ID
  "ClientID": "adfaadf-adfad12323-adfadfadf", // 登录mqtt服务时注册的ID
  "Data": {
    "OperationType": 1, // 操作类型 0：配置tcf，1：配置tbf
    "ConstaraintUpdate": false, // 配置tcf或tbf后是否强制更新case
    "ConfigPath": "E:\\Project\\VCarEA\\Autotest\\config.tcf" // 文件路径
  }
}
```

- 应答主题：`KY/VCar/EA/SettingConfiguration/Response`

应答消息：

```json
{
  "ID": "123", // 请求接入时的消息ID
  "Code": 0, // 状态代码
  "Msg": "succeed", // 消息内容
  "ClientID": "adfaadf-adfad12323-adfadfadf"
}
```

### 3.4 启动/停止实验环境

- 请求主题：`KY/VCar/EA/Environment/Request`

请求消息：

```json
{
  "ID": "123", // 消息ID，标识本条消息的唯一ID，消息应答时答复的ID
  "ClientID": "adfaadf-adfad12323-adfadfadf", // 登录mqtt服务时注册的ID
  "Data": {
    "OperationType": 1, // 操作类型 0：启动实验环境，1：停止实验环境
    "TestbenchConfigurationPath": "/workspace/VCarEA/Configurations/测试模型/TestbenchConfiguration_all_type.tbf" // tbf的绝对路径，仅linux版本需要
  }
}
```

- 应答主题：`KY/VCar/EA/Environment/Response`

应答消息：

```json
{
  "ID": "123", // 请求接入时的消息ID
  "Code": 0, // 状态代码
  "Msg": "succeed", // 消息内容
  "ClientID": "adfaadf-adfad12323-adfadfadf"
}
```

### 3.5 获取Case列表

通过该项接口可以获取EA项目中的Case节点列表。

- 请求主题：`KY/VCar/EA/Cases/Request`

请求消息：

```json
{
  "ID": "123", // 消息ID，标识本条消息的唯一ID，消息应答时答复的ID
  "ClientID": "adfaadf-adfad12323-adfadfadf" // 登录mqtt服务时注册的ID
}
```

- 应答主题：`KY/VCar/EA/Cases/Response`

应答消息：

```json
{
  "ID": "123", // 请求接入时的消息ID
  "Code": 0, // 状态代码
  "Msg": "succeed", // 消息内容
  "ClientID": "adfaadf-adfad12323-adfadfadf",
  "Data": [
    {
      "Type": "case", // 文件类型
      "Path": "VCarEA\\cases\\Testbench.case" // 文件路径
    },
    {
      "Type": "tcf",
      "Path": "VCarEA\\cases\\Test.case"
    }
  ]
}
```

### 3.6 获取Plan列表

通过该项接口可以获取EA项目中的Plan节点列表。

- 请求主题：`KY/VCar/EA/Plans/Request`

请求消息：

```json
{
  "ID": "123", // 消息ID，标识本条消息的唯一ID，消息应答时答复的ID
  "ClientID": "adfaadf-adfad12323-adfadfadf" // 登录mqtt服务时注册的ID
}
```

- 应答主题：`KY/VCar/EA/Plans/Response`

应答消息：

```json
{
  "ID": "123", // 请求接入时的消息ID
  "Code": 0, // 状态代码
  "Msg": "succeed", // 消息内容
  "ClientID": "adfaadf-adfad12323-adfadfadf",
  "Data": [
    {
      "Type": "plan", // 文件类型
      "Path": "VCarEA\\plans\\Testbench.plan" // 文件路径
    },
    {
      "Type": "plan",
      "Path": "VCarEA\\plans\\Test.plan"
    }
  ]
}
```

### 3.7 打开/关闭Case

- 请求主题：`KY/VCar/EA/Case/Operation/Request`

请求消息：

```json
{
  "ID": "123", // 消息ID，标识本条消息的唯一ID，消息应答时答复的ID
  "ClientID": "adfaadf-adfad12323-adfadfadf", // 登录mqtt服务时注册的ID
  "Data": {
    "OperationType": 0, // 0：打开，1：关闭
    "CasePath": "C:\\VCarEA\\cases\\Testbench.case" // Case的全路径，注意使用绝对路径
  }
}
```

- 应答主题：`KY/VCar/EA/Case/Operation/Response`

应答消息：

```json
{
  "ID": "123", // 请求接入时的消息ID
  "Code": 0, // 状态代码
  "Msg": "succeed", // 消息内容
  "ClientID": "adfaadf-adfad12323-adfadfadf",
  "Data": [
    {
      "StepID": "adafdsfa", // stepID
      "Name": "Step", // 步骤名称
      "Action": "Waite" // 操作功能
    }
  ]
}
```

### 3.8 启动/停止Case

- 请求主题：`KY/VCar/EA/Case/Execute/Request`

请求消息：

```json
{
  "ID": "123", // 消息ID，标识本条消息的唯一ID，消息应答时答复的ID
  "ClientID": "adfaadf-adfad12323-adfadfadf", // 登录mqtt服务时注册的ID
  "Data": {
    "OperationType": 0, // 0：执行，1：停止Case
    "CasePath": "C:\\VCarEA\\cases\\Testbench.case", // Case路径，注意使用绝对路径
    "UpdateVariables": [
      // 配置变量初始值，如果该字段为null则使用case中的变量初始值
      {
        "VariableName": "test",
        "Value": "123",
        "ValueMode": 0 // 0：单值，1：多值
      }
    ],
    "ProjectPath": "/workspace/VCarEA", // 项目路径，仅linux版本需要
    "TestConfigurationPath": "/workspace/VCarEA/Configurations/测试模型/TestConfiguration_all_type.tcf", // tcf绝对路径，仅linux版本需要
    "TestbenchConfigurationPath": "/workspace/VCarEA/Configurations/测试模型/TestbenchConfiguration_all_type.tbf" // tbf绝对路径，仅linux版本需要
  }
}
```

- 应答主题：`KY/VCar/EA/Case/Execute/Response`

应答消息：

```json
{
  "ID": "123", // 请求接入时的消息ID
  "Code": 0, // 状态代码
  "Msg": "succeed", // 消息内容
  "ClientID": "adfaadf-adfad12323-adfadfadf",
  "Data": {
    "ReportPath": "E://adsf/sdfa/sadf_2024 12 18"
  }
}
```

### 3.9 打开/关闭Plan

- 请求主题：`KY/VCar/EA/Plan/Operation/Request`

请求消息：

```json
{
  "ID": "123", // 消息ID，标识本条消息的唯一ID，消息应答时答复的ID
  "ClientID": "adfaadf-adfad12323-adfadfadf", // 登录mqtt服务时注册的ID
  "Data": {
    "OperationType": 0, // 0：打开，1：关闭
    "PlanPath": "C:\\VCarEA\\Plans\\Testbench.Plan" // Plan的全路径，注意使用绝对路径
  }
}
```

- 应答主题：`KY/VCar/EA/Plan/Operation/Response`

应答消息：

```json
{
  "ID": "123", // 请求接入时的消息ID
  "Code": 0, // 状态代码
  "Msg": "succeed", // 消息内容
  "ClientID": "adfaadf-adfad12323-adfadfadf",
  "Data": [
    {
      "CaseID": "adafdsfa", // CaseID
      "Path": "VCarEA\\cases\\Testbench.case" // Plan中Case的全路径
    }
  ]
}
```

### 3.10 启动/停止Plan

- 请求主题：`KY/VCar/EA/Plan/Execute/Request`

请求消息：

```json
{
  "ID": "123", // 消息ID，标识本条消息的唯一ID，消息应答时答复的ID
  "ClientID": "adfaadf-adfad12323-adfadfadf", // 登录mqtt服务时注册的ID
  "Data": {
    "OperationType": 0, // 0：执行，1：停止执行
    "PlanPath": "C:\\VCarEA\\plans\\Testbench.plan", // plan路径，注意使用绝对路径
    "UpdateVariables": [
      // 配置变量初始值
      {
        "VariableName": "test(Cases\\a.case)", // 括号内容为选填，为case相对路径
        "Value": "123",
        "ValueMode": 0 // 0：单值，1：多值
      }
    ],
    "ProjectPath": "/workspace/VCarEA", // 项目路径，仅linux版本需要
    "TestConfigurationPath": "/workspace/VCarEA/Configurations/测试模型/TestConfiguration_all_type.tcf", // tcf绝对路径，仅linux版本需要
    "TestbenchConfigurationPath": "/workspace/VCarEA/Configurations/测试模型/TestbenchConfiguration_all_type.tbf" // tbf绝对路径，仅linux版本需要
  }
}
```

- 应答主题：`KY/VCar/EA/Plan/Execute/Response`

应答消息：

```json
{
  "ID": "123", // 请求接入时的消息ID
  "Code": 0, // 状态代码
  "Msg": "succeed", // 消息内容
  "ClientID": "adfaadf-adfad12323-adfadfadf",
  "Data": {
    "ReportPath": "E://adsf/sdfa/sadf_2024 12 18"
  }
}
```

### 3.11 自动生成Plan

- 请求主题：`KY/VCar/EA/Plan/AutoGenerate/Request`

请求消息：

```json
{
  "ID": "123", // 消息ID，标识本条消息的唯一ID，消息应答时答复的ID
  "ClientID": "adfaadf-adfad12323-adfadfadf", // 登录mqtt服务时注册的ID
  "Data": {
    "FileName": "Test.plan", // plan文件名称，要符合文件名规则
    "Destination": "", // 文件保存位置，要符合Windows路径规则，不填写则指向EA工作空间的Plans节点，路径要在EA项目Plans节点范围
    "Strategy": 0, // 策略配置的失败重试次数，默认为0，失败不重试
    "Sequences": [
      // plan文件包含的case列表
      {
        "Case": "", // 必填项，Case要在EA项目中存在
        "Loop": 1 // 循环次数，默认为1，最小值为1
      }
    ]
  }
}
```

- 应答主题：`KY/VCar/EA/Plan/AutoGenerate/Response`

应答消息：

```json
{
  "ID": "123", // 请求接入时的消息ID
  "Code": 0, // 状态代码
  "Msg": "succeed", // 消息内容
  "ClientID": "adfaadf-adfad12323-adfadfadf",
  "Data": {
    "FileName": "VCarEA\\plans\\Test.plan" // 操作成功后生成的plan文件路径
  }
}
```

### 3.12 报告下载接口

#### 3.12.1 报告下载请求接口

- 请求主题：`KY/VCar/EA/Report/Download/Request`

请求消息：

```json
{
  "ID": "123", // 消息ID，标识本条消息的唯一ID，消息应答时答复的ID
  "ClientID": "adfaadf-adfad12323-adfadfadf", // 登录mqtt服务时注册的ID
  "Data": {
    "ReportPath": "E://adsf/sdfa/sadf_2024 12 18"
  }
}
```

- 应答主题：`KY/VCar/EA/Report/Download/Response`

应答消息：

```json
{
  "ID": "123", // 请求接入时的消息ID
  "Code": 0, // 状态代码
  "Msg": "succeed", // 消息内容
  "ClientID": "adfaadf-adfad12323-adfadfadf",
  "Data": {
    "PushVoucher": "adfadfda123123sdfads21341231", // 当前报告请求凭证，用于启动报告推送，报告推送完成后凭证失效
    "ReportPushTopic": "KY/VCar/EA/Report/Download/123", // 报告推送主题
    "ReportBytesSize": 128000, // 推送报告总大小，bytes长度
    "PushPackCount": 3, // 推送数据包数量，将数据拆分成多个数据包推送
    "FileFormatType": 0, // 0表示zip格式，当前接口仅支持zip格式
    "FileHashCode": "adsfadsfasd-adfad-fa-12312-123" // 报告数据哈希
  }
}
```

#### 3.12.2 启动报告推送接口

- 请求主题：`KY/VCar/EA/Report/Push/Request`

请求消息：

```json
{
  "ID": "123", // 消息ID，标识本条消息的唯一ID，消息应答时答复的ID
  "ClientID": "adfaadf-adfad12323-adfadfadf", // 登录mqtt服务时注册的ID
  "Data": {
    "PushVoucher": "adfadfda123123sdfads21341231"
  }
}
```

- 应答主题：`KY/VCar/EA/Report/Push/Response`

应答消息：

```json
{
  "ID": "123", // 请求接入时的消息ID
  "Code": 0, // 状态代码
  "Msg": "succeed", // 消息内容
  "ClientID": "adfaadf-adfad12323-adfadfadf"
}
```

#### 3.12.3 报告推送数据包结构

|          | index      | DataLength | Data     |
| -------- | ---------- | ---------- | -------- |
| 数据类型 | int        | int        | bytes    |
| 字节长度 | 4 byte     | 4 byte     | N byte   |
| 备注     | 数据包索引 | 数据长度   | 数据内容 |

#### 3.12.4 编码实现示例

- Python（原文档此处未附带具体代码内容）

### 3.13 查询执行的Mqtt端口

- 请求主题：`KY/VCar/EA/Execution/MqttPort/Request`

请求消息：

```json
{
  "ID": "123", // 消息ID，标识本条消息的唯一ID，消息应答时答复的ID
  "ClientID": "adfaadf-adfad12323-adfadfadf" // 登录mqtt服务时注册的ID
}
```

- 应答主题：`KY/VCar/EA/Execution/MqttPort/Response`

应答消息：

```json
{
  "ID": "123", // 请求接入时的消息ID
  "Code": 0, // 状态代码
  "Msg": "succeed", // 消息内容
  "ClientID": "adfaadf-adfad12323-adfadfadf",
  "Data": {
    "ExecutionMqttPort": 17589 // 如未开始执行，则返回0
  }
}
```

## 4. 报告接口

报告接口只作为消息订阅，客户端允许进行数据发送。

### 4.1 VCarEA报告合并接口

- 请求主题：`KY/VCar/EA/TestReport/Commbine/Request`

请求消息：

```json
{
  "ID": "123", // 消息ID，标识本条消息的唯一ID，消息应答时答复的ID
  "ClientID": "adfaadf-adfad12323-adfadfadf", // 登录mqtt服务时注册的ID
  "Data": {
    "NewReportPath": "", // 合成新报告存放路径
    "CommbineReportPaths": [
      // 需要合成的报告列表
      {
        "ReportPath": "E://adsf/sdfa/sadf_1_2024 12 18"
      },
      {
        "ReportPath": "E://adsf/sdfa/sadf_2_2024 12 18"
      }
    ]
  }
}
```

- 应答主题：`KY/VCar/EA/TestReport/Commbine/Response`

应答消息：

```json
{
  "ID": "123", // 请求接入时的消息ID
  "Code": 0, // 状态代码
  "Msg": "succeed", // 消息内容
  "ClientID": "adfaadf-adfad12323-adfadfadf"
}
```

### 4.2 VCarEARun接口

定义VCarEARun的启动和停止接口主题为：

- 启动主题：`VCar/EA/TestReport/Run/Start`
- 停止主题：`VCar/EA/TestReport/Run/Stop`

#### 4.2.1 启动数据接口

启动时发布启动主题`VCar/EA/TestReport/Run/Start`并以下列数据结构为数据内容发布。

| 字段名称            | 类型   | 说明                                 |
| ------------------- | ------ | ------------------------------------ |
| ID                  | string | GUID字符串                           |
| FileID              | string | Guid                                 |
| Name                | string | 运行名称                             |
| ShortName           | string | Case/Plan简称                        |
| PorjectName         | string | 项目名称                             |
| TestConfigName      | string | 测试配置文件名                       |
| TestbenchConfigName | string | 测试台配置文件名                     |
| Parameters          | string | 执行参数                             |
| StartTime           | double | 启动时间（当前时间的时间戳）单位：秒 |

#### 4.2.2 停止数据接口

停止时发布停止主题`VCar/EA/TestReport/Run/Stop`并以下列数据结构为数据内容发布。

| 字段名称      | 类型   | 说明                                 |
| ------------- | ------ | ------------------------------------ |
| ID            | string | GUID字符串                           |
| StopTime      | double | 停止时间（当前时间的时间戳）单位：秒 |
| PlanCount     | int    | Plan数量                             |
| PlanFailCount | int    | Plan失败数量                         |
| CaseCount     | int    | Case数量                             |
| CaseFailCount | int    | Case失败数量                         |
| StepCount     | int    | Step数量                             |
| StepFailCount | int    | Step失败数量                         |

### 4.3 VCarEAPlan接口

定义VCarEAPlan的启动和停止接口主题为：

- 启动主题：`VCar/EA/TestReport/Plan/Start`
- 停止主题：`VCar/EA/TestReport/Plan/Stop`

#### 4.3.1 启动数据接口

启动时发布启动主题`VCar/EA/TestReport/Plan/Start`并以下列数据结构为数据内容发布。

| 字段名称  | 类型   | 说明                                 |
| --------- | ------ | ------------------------------------ |
| ID        | string | GUID字符串                           |
| RunID     | string | VCarEA_Run 唯一标识                  |
| FileID    | string | 文件ID                               |
| Name      | string | Plan文件名称                         |
| ParenID   | string | 上级ID                               |
| StartTime | double | 启动时间（当前时间的时间戳）单位：秒 |

#### 4.3.2 停止数据接口

停止时发布停止主题`VCar/EA/TestReport/Plan/Stop`并以下列数据结构为数据内容发布。

| 字段名称      | 类型   | 说明                                 |
| ------------- | ------ | ------------------------------------ |
| ID            | string | GUID字符串                           |
| RunID         | string | VCarEA_Run 唯一标识                  |
| StopTime      | double | 停止时间（当前时间的时间戳）单位：秒 |
| CaseCount     | int    | Case数量                             |
| CaseFailCount | int    | Case失败数量                         |
| StepCount     | int    | Step数量                             |
| StepFailCount | int    | Step失败数量                         |

### 4.4 VCarEACase接口

定义VCarEACase的启动和停止接口主题为：

- 启动主题：`VCar/EA/TestReport/Case/Start`
- 停止主题：`VCar/EA/TestReport/Case/Stop`

#### 4.4.1 启动数据接口

启动时发布启动主题`VCar/EA/TestReport/Case/Start`并以下列数据结构为数据内容发布。

| 字段名称  | 类型   | 说明                                 |
| --------- | ------ | ------------------------------------ |
| ID        | string | GUID字符串                           |
| RunID     | string | VCarEA_Run 唯一标识                  |
| PlanID    | string | VCarEA_Plan 唯一标识（允许为Null）   |
| FileID    | string | 文件ID                               |
| Name      | string | Case名称                             |
| Type      | string | 序列类型（TCC,TSG）                  |
| StartTime | double | 启动时间（当前时间的时间戳）单位：秒 |
| ParentID  | string | 上一级CaseID，如果不存在则为空       |
| IsValid   | bool   | Case是否有效                         |

#### 4.4.2 停止数据接口

停止时发布停止主题`VCar/EA/TestReport/Case/Stop`并以下列数据结构为数据内容发布。

| 字段名称      | 类型   | 说明                                 |
| ------------- | ------ | ------------------------------------ |
| ID            | string | GUID字符串                           |
| StopTime      | double | 停止时间（当前时间的时间戳）单位：秒 |
| CaseCount     | int    | Case数量                             |
| CaseFailCount | int    | Case失败数量                         |
| StepCount     | int    | Step数量                             |
| StepFailCount | int    | Step失败数量                         |

### 4.5 VCarEAStep接口

定义VCarEAStep的启动和停止接口主题为：

- 启动主题：`VCar/EA/TestReport/Step/Start`
- 停止主题：`VCar/EA/TestReport/Step/Stop`

#### 4.5.1 启动数据接口

启动时发布启动主题`VCar/EA/TestReport/Step/Start`并以下列数据结构为数据内容发布。

| 字段名称  | 类型   | 说明                                 |
| --------- | ------ | ------------------------------------ |
| ID        | string | GUID字符串                           |
| RunID     | string | VCarEA_Run 唯一标识                  |
| PlanID    | string | VCarEA_Plan 唯一标识                 |
| StepID    | string | 步骤ID                               |
| CaseID    | string | VCarEA_Case 唯一标识                 |
| Name      | string | 步骤名称                             |
| ParentID  | string | 上一级StepID，如果不存在则为Null     |
| StartTime | double | 启动时间（当前时间的时间戳）单位：秒 |

#### 4.5.2 执行中事件推送

在启动后执行过程中推送的相关消息，如执行状态、注释、图片资源等，推送主题为：`VCar/EA/TestReport/Step/UnderWay`

```json
{
  "ID": "adfadfadffadfadf", // 步骤ID
  "Code": 100, // 推送事件代码，该代码可参照报告消息状态代码章节内容
  "Data": [] // 数据集合，内容格式参考报告消息状态代码章节内容格式
}
```

#### 4.5.3 停止数据接口

停止时发布停止主题`VCar/EA/TestReport/Step/Stop`并以下列数据结构为数据内容发布。

| 字段名称       | 类型   | 说明                                           |
| -------------- | ------ | ---------------------------------------------- |
| ID             | string | GUID字符串                                     |
| RunID          | string | VCarEA_Run 唯一标识                            |
| StopTime       | double | 停止时间（当前时间的时间戳）单位：秒           |
| Type           | string | 步骤类型（TCS，TCG）                           |
| Action         | string | 步骤Action                                     |
| Value          | string | 值                                             |
| MappingName    | string | 名称（映射名称、Cascade引用路径）              |
| Expectation    | string | 期望值                                         |
| Msg            | string | 消息，当手动停止时，该字段内容为固定：Terminal |
| CustomMsg      | string | 断言消息                                       |
| Signals        | string | 信号                                           |
| Result         | string | 运行结果值                                     |
| IsPass         | bool   | 评估结果                                       |
| Annotation     | string | 注释                                           |
| IsResourceStep | bool   | 是否是资源                                     |
| ResourceBase64 | string | 资源的Base64                                   |
| ResourceSuffix | string | 资源后缀                                       |
| ResourceName   | string | 资源名称                                       |
| ResourceType   | int    | 资源类型枚举：0：png，1：jpg，2：txt           |

### 4.6 报告消息状态代码

| 状态代码 | 属性命名  | 代码内容   |
| -------- | --------- | ---------- |
| 1000     | Msg       | 消息       |
| 1001     | CustomMsg | 自定义消息 |
| 1002     | Resource  | 资源       |

#### 4.6.1 Msg

```json
{
  "Msg": "消息内容"
}
```

#### 4.6.2 CustomMsg

```json
{
  "CustomMsg": "自定义消息"
}
```

#### 4.6.3 Resource

```json
{
  "ResourceType": 0, // 0 文件base64，1 网络地址 2 本地路径
  "Name": "sdfadfa.jpg", // 资源名称
  "Suffix": ".jpg", // 后缀名称
  "ResourceBase64": "adfadfzaadfaaasdf==" // 资源数据的base64字符串
}
```

## 5. 状态代码

### 通用状态代码

| 状态代码 | 属性命名 | 代码内容 |
| -------- | -------- | -------- |
| 0        | Success  | 成功     |
| 1        | Fail     | 失败     |
| 2        | Timeout  | 超时     |
| 3        | Unlawful | 非法调用 |
| 4        | Error    | 系统错误 |

### 业务状态

| 状态代码 | 属性命名 | 代码内容           |
| -------- | -------- | ------------------ |
| 104      |          | 项目已关闭或未打开 |
| 105      |          | 缺少测试配置       |
| 106      |          | 缺少测试台配置     |
| 107      |          | mrtd连接失败       |
| 108      |          | 执行步骤无效       |
| 109      |          | 执行Case无效       |
