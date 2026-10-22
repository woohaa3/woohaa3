import { imageFamilyParameters } from "@woohaa3/contracts";
/** Source CLI parameters are intent; adapt them to the selected host model's input contract. */
export function imageRequestParameters(modelKey:string,parameters:Record<string,unknown>):Record<string,unknown> {
  if(!modelKey.startsWith("litellm:"))return {...parameters};
  const {aspectRatio,requestSize: _requestSize,requestQuality,format,...rest}=parameters;
  const family=imageFamilyParameters(modelKey.slice("litellm:".length));
  if(family)return {...rest,...(aspectRatio?{aspectRatio}:{}),...(_requestSize&&!rest.resolution?{resolution:_requestSize}:{}),...(requestQuality&&!rest.quality&&family.properties.quality?{quality:requestQuality}:{})};
  // Unknown families retain the generic OpenAI pixel-size contract.
  const size=aspectRatio==="1:1"?"1024x1024":aspectRatio==="3:2"?"1536x1024":aspectRatio==="2:3"?"1024x1536":undefined;
  return {...rest,...(size&&!rest.size?{size}:{}),...(requestQuality&&!rest.quality?{quality:requestQuality}:{}),...(format&&!rest.outputFormat?{outputFormat:format}:{})};
}
