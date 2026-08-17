import * as task from "@atech/task";

const message = "Hello, World!";

export function helloWorld() {
    task.log("info", message);
    task.output("MESSAGE", message);
    task.progress(100, message);
    return message;
}
