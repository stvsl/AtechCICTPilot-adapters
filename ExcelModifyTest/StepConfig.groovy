stages {
    stage("更新 FlashPath.CfgDriverFile 为当前时间") {
        timeout(30000)
        steps {
            runjs("scripts/excel_modify_test.js", "modifyWorkbook", "plugin://scripts/data/BootloaderTest.xlsx")
        }
    }
}
