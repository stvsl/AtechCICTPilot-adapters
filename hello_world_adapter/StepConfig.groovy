stages {
    stage("Hello World") {
        timeout(660000)
        steps {
            runjs("scripts/hello_world.js", "helloWorld", env.WAIT_DURATION_SECONDS)
        }
    }
}
