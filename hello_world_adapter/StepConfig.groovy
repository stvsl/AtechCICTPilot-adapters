stages {
    stage("Hello World") {
        timeout(30000)
        steps {
            runjs("scripts/hello_world.js", "helloWorld")
        }
    }
}
