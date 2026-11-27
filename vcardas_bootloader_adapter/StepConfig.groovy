stages {
    stage("准备工程与刷写文件") {
        timeout(120000)
        steps {
            runjs("scripts/entry.js", "prepare")
        }
    }
    stage("准备工程打包输入") {
        timeout(150000)
        steps {
            runjs("scripts/entry.js", "preparePacking")
        }
    }
    stage("加载固定刷写目录") {
        timeout(150000)
        steps {
            runjs("scripts/entry.js", "loadFixedDirectory")
        }
    }
    stage("核验工具并打开任务工程") {
        timeout(360000)
        steps {
            runjs("scripts/entry.js", "openTool")
        }
    }
    stage("重建模块与编译") {
        timeout(900000)
        steps {
            runjs("scripts/entry.js", "configureModules")
        }
    }
    stage("汇总各目标结果") {
        timeout(30000)
        steps {
            runjs("scripts/entry.js", "collectResults")
        }
    }
}
post {
    always {
        stage("停止测量并关闭软件") {
            timeout(600000)
            steps {
                runjs("scripts/entry.js", "cleanup")
            }
        }
    }
}
