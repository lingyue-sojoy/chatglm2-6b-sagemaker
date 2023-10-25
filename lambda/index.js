import { SageMakerRuntimeClient, InvokeEndpointWithResponseStreamCommand } from "@aws-sdk/client-sagemaker-runtime"; // ES Modules import
const client = new SageMakerRuntimeClient({});

const MODEL_NAME = "chatglm2-6b";

export const handler = awslambda.streamifyResponse(async (event, responseStream, _context) => {
  // console.log("\n=== Event ===\n", event);
  if ((!event.headers.hasOwnProperty("Authorization") || event.headers["Authorization"] != `Bearer ${process.env.API_KEY}`) &&
      (!event.headers.hasOwnProperty("authorization") || event.headers["authorization"] != `Bearer ${process.env.API_KEY}`)) {
    const metadata = {
      statusCode: 403,
      headers: {
        "Content-Type": "text/plain"
      }
    };
    responseStream = awslambda.HttpResponseStream.from(responseStream, metadata);
    responseStream.write("Unauthorized");
    responseStream.end();
    return;
  }
  if (!event.body) {
    const metadata = {
      statusCode: 400,
      headers: {
        "Content-Type": "text/plain"
      }
    };
    responseStream = awslambda.HttpResponseStream.from(responseStream, metadata);
    responseStream.write("Bad Request");
    responseStream.end();
    return;
  }
  const body = JSON.parse(event.body);
  const stream = body.stream && body.stream != "false" ? true : false;
  const messages = body.messages;
  const message = messages.pop();
  if (message.role != "user") {
    const metadata = {
      statusCode: 400,
      headers: {
        "Content-Type": "text/plain"
      }
    };
    responseStream = awslambda.HttpResponseStream.from(responseStream, metadata);
    responseStream.write("Bad Request");
    responseStream.end();
    return;
  }
  const query = message.content;
  if (messages.length > 0 && messages[0].role == "system") {
    query = messages.pop(0).content + query;
  }
  const history = [];
  let currentRole = "";
  let currentUserMessage = "";
  let currentAssistantMessage = "";
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role != currentRole) {
      currentRole = messages[i].role;
      if (currentUserMessage != "" && currentAssistantMessage != "") {
        history.append([currentUserMessage, currentAssistantMessage]);
        currentUserMessage = "";
        currentAssistantMessage = "";
      }
    }
    if (messages[i].role == currentRole) {
      if (messages[i].role == "user") {
        currentUserMessage = currentUserMessage == "" ? messages[i].content : currentUserMessage + "\n" + messages[i].content;
      } else if (messages[i].role == "assistant") {
        currentAssistantMessage = currentAssistantMessage == "" ? messages[i].content : currentAssistantMessage + "\n" + messages[i].content;
      }
    }
  }
  const input = { // InvokeEndpointWithResponseStreamInput
    EndpointName: process.env.ENDPOINT_NAME, // required
    Body: JSON.stringify({
      inputs: query,
      history,
    }), // required
    ContentType: "application/json"
  };
  if (stream) {
    const metadata = {
      statusCode: 200,
      headers: {
        "Content-Type": "text/event-stream"
      }
    };
    responseStream = awslambda.HttpResponseStream.from(responseStream, metadata);
  } else {
    const metadata = {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json"
      }
    };
    responseStream = awslambda.HttpResponseStream.from(responseStream, metadata);
  }
  try {
    const command = new InvokeEndpointWithResponseStreamCommand(input);
    const response = await client.send(command);
    const decoder = new TextDecoder();
    let content = "";
    for await (const chunk of response.Body) {
      try {
        const str = decoder.decode(chunk.PayloadPart.Bytes, { stream: true }).replace(/\\u([0-9a-fA-F]{4})/g, (m,cc)=>String.fromCharCode("0x"+cc));;
        console.log("chunk", str);
        const data = JSON.parse(str);
        const delta = data.outputs;
        if (!delta || delta == "")
          continue;
        content += delta;
        const result = {
          id: "",
          object: "chat.completion.chunk",
          created: Date.now(),
          model: MODEL_NAME,
          choices: [
            {
              delta: {
                role:"assistant",
                content: delta
              },
              index: 0,
              finish_reason: null
            }
          ]
        };
        if (stream) {
          responseStream.write(`data: ${JSON.stringify(result)}\n\n`);
        }
      }
      catch (e) {
        console.error(`WARN`, e);
      }
    }
    if (stream) {
      responseStream.write(`data: [DONE]\n\n`);
    } else {
      responseStream.write(JSON.stringify({
        id: "",
        object: "chat.completion",
        created: Date.now(),
        model: MODEL_NAME,
        choices: [
          {
            message: {
              role: "assistant",
              content
            },
            finish_reason: "stop",
            index: 0
          }
        ]
      }));
    }
  }
  catch (e) {
    console.error(`FATAL`, e);
    const metadata = {
      statusCode: 500,
      headers: {
        "Content-Type": "text/plain"
      }
    };
    responseStream = awslambda.HttpResponseStream.from(responseStream, metadata);
    responseStream.write("Internal Server Error");
  }
  finally {
    responseStream.end();
  }
});