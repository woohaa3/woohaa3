/** Only insertText is eligible. Paste, replacement and IME input retain their bytes. */
export function smartQuotedInput(previous:string,next:string,at:number,inputType:string,data:string|null,enabled:boolean,composing:boolean):string {
 if(!enabled || composing || inputType!=="insertText" || !data || !/["']/.test(data) || at<data.length || at>next.length || next.slice(at-data.length,at)!==data)return next;
 const start=at-data.length;
 // Ignore malformed browser events rather than rewriting existing text.
 if(next.slice(0,start)!==previous.slice(0,start))return next;
 let before=Array.from(next.slice(0,start)).at(-1),typed="";
 for(const character of data){const open=before===undefined || /\s|[([{\-–—]/u.test(before);const value=character==='"'?(open?'“':'”'):character==="'"?(open?'‘':'’'):character;typed+=value;before=value;}
 return next.slice(0,start)+typed+next.slice(at);
}
