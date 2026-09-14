/* VCarEA 安装目录与关键文件定位工具。
 *
 * 查找规则参照适配器 docs/sdk_loader.py：
 *  - 起点为工位属性配置的软件路径，未配置时使用本机默认安装目录；
 *  - 配置指向 CentralServices/Drivers/Executor 等子目录时回退到上级安装根目录；
 *  - VCarEA 主可执行文件与 Connector SDK 程序集位于同一安装根目录。
 *
 * 插件运行时的文件系统只允许访问 URI 根，因此这里只推导候选路径；
 * 路径是否真实存在由 cli / dllnet 调用结果判定，并在失败时使用
 * describeInstallation() 给出完整诊断。
 */

/** 本机默认安装目录（VCarEA 的约定安装位置）。 */
export const DEFAULT_INSTALL_ROOT = "C:\\KunyiSoftwares\\VCarEA";

/** VCarEA 主可执行文件名。 */
export const EXECUTABLE_NAME = "VCarEA.exe";

/** Connector SDK 程序集文件名（docs/main.py 查询连接配置使用的同一程序集）。 */
export const CONNECTOR_SDK_NAME = "KY.VCar.Central.Connector.Sdk.dll";

/** 中央服务可执行文件相对安装根目录的路径。 */
export const CENTRAL_SERVICE_RELATIVE_PATH =
    "CentralServices\\VCarEA.Central.Service.exe";

/** 已知只部署子服务、不含 Connector SDK 的目录名。 */
const DIRECTORIES_WITHOUT_SDK = ["centralservices", "drivers", "executor"];

/** 向上回退的最大层数，避免异常配置导致路径被无限裁剪。 */
const MAXIMUM_PARENT_STEPS = 4;

function asText(value) {
    return value === undefined || value === null ? "" : String(value).trim();
}

/** 去掉路径末尾的目录分隔符。 */
function stripTrailingSeparators(path) {
    let result = path;
    while (result.length > 3
            && (result.endsWith("\\") || result.endsWith("/"))) {
        result = result.substring(0, result.length - 1);
    }
    return result;
}

/** 判断路径是否指向可执行文件。 */
export function isExecutablePath(path) {
    return /\.exe$/i.test(asText(path));
}

/** 拆分本机路径为目录与末段名称；带盘符的根目录末段为空。 */
export function splitNativePath(path) {
    const normalized = stripTrailingSeparators(asText(path));
    const index = Math.max(normalized.lastIndexOf("\\"),
                           normalized.lastIndexOf("/"));
    if (index < 0) {
        return {directory: "", name: normalized};
    }
    return {
        directory: normalized.substring(0, index),
        name: normalized.substring(index + 1),
    };
}

/** 拼接本机路径片段，保持输入中的分隔符风格。 */
export function joinNativePath(basePath, ...parts) {
    let result = stripTrailingSeparators(asText(basePath));
    for (const part of parts) {
        const segment = asText(part).replace(/^[\\/]+/, "");
        if (segment === "") {
            continue;
        }
        result = `${result}\\${segment}`;
    }
    return result;
}

/** 解析软件安装根目录：接受可执行文件路径或目录路径。 */
export function resolveInstallRoot(softwarePath) {
    const configured = asText(softwarePath);
    if (configured === "") {
        return DEFAULT_INSTALL_ROOT;
    }
    let root = isExecutablePath(configured)
        ? splitNativePath(configured).directory
        : stripTrailingSeparators(configured);
    // 配置误指向子服务目录时，回退到真正的安装根目录。
    for (let step = 0; step < MAXIMUM_PARENT_STEPS; ++step) {
        const name = splitNativePath(root).name.toLowerCase();
        if (!DIRECTORIES_WITHOUT_SDK.includes(name)) {
            break;
        }
        const parent = splitNativePath(root).directory;
        if (parent === "") {
            break;
        }
        root = parent;
    }
    return root;
}

/** 解析 VCarEA 可执行文件路径。 */
export function resolveExecutablePath(softwarePath) {
    const configured = asText(softwarePath);
    if (isExecutablePath(configured)) {
        return stripTrailingSeparators(configured);
    }
    return joinNativePath(resolveInstallRoot(configured), EXECUTABLE_NAME);
}

/** 解析完整安装布局；所有路径都按约定规则推导。 */
export function resolveInstallation(softwarePath) {
    const installRoot = resolveInstallRoot(softwarePath);
    return {
        SoftwarePath: asText(softwarePath),
        InstallRoot: installRoot,
        ExecutablePath: resolveExecutablePath(softwarePath),
        ConnectorSdkPath: joinNativePath(installRoot, CONNECTOR_SDK_NAME),
        CentralServicePath:
            joinNativePath(installRoot, CENTRAL_SERVICE_RELATIVE_PATH),
    };
}

/** 生成安装布局诊断文本，用于失败信息与日志。 */
export function describeInstallation(installation) {
    return [
        `安装目录 ${installation.InstallRoot}`,
        `可执行文件 ${installation.ExecutablePath}`,
        `Connector SDK ${installation.ConnectorSdkPath}`,
        `中央服务 ${installation.CentralServicePath}`,
    ].join("；");
}
