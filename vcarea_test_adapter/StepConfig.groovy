stages {
    stage("启动VCarEA") {
        timeout(180000)
        steps {
            runjs("scripts/vcarea_test.js", "launch")
        }
    }
    stage("获取MQTT连接配置") {
        timeout(60000)
        steps {
            runjs("scripts/vcarea_test.js", "readMqttConfig")
        }
    }
}
post {
    always {
        runjs("scripts/vcarea_test.js", "cleanup")
    }
}
