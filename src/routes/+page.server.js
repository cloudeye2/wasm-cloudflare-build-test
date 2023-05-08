import { OpenAI } from "langchain/llms/openai";


// @ts-ignore
export async function load() {
  //create openai embeddings with api key 
  const model = new OpenAI({ openAIApiKey: "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", temperature: 0.8 });
  const res = await model.call(
    "What would be a good company name a company that makes colorful socks?"
  );
  return res;
 
}
