import { OpenAI } from "langchain/llms/openai";


// @ts-ignore
export async function load() {
  //create openai embeddings with api key 
  const model = new OpenAI();
  const res = await model.call(
    "What would be a good company name a company that makes colorful socks?"
  );
  return res;
 
}
