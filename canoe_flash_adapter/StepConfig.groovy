stages {
    stage('清理残留CANoE进程') {
        steps {
            runjs "/scrpits/CleanCanoe.js"
        }
    }
    stage('设置硬件通路'){
        steps{
            runjs ""
        }
    }
    stage('准备CANoE工程'){
        steps{
            runjs("",${env.CANOE_PROJECT},${env.SOFTWARE_PACKAGE})
        }
    }
    stage('启动CANoE'){
        steps{
            runjs ""
        }
    }
    stage('加载CANoE工程'){
        steps{
            runjs ""
        }
    }
    stage('开始刷写'){
        steps{
            runjs ""
        }
    }
    stage('结束刷写'){
        steps{
            runjs ""
        }
    }
}