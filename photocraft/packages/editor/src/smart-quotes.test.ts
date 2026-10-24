import {expect,it} from "vitest";
import {smartQuotedInput as quote} from "./smart-quotes.js";
it("typed quotes follow whitespace, punctuation and previous characters including Unicode",()=>{
 for(const [before,typed,expected] of [["",'"',"“"],["hello",'"',"hello”"],["(","'","(‘"],["—",'"',"—“"],["can","'t","can’t"],["中文",'"',"中文”"],["😀",'"',"😀”"],["",'"hello"',"“hello”"]])expect(quote(before,before+typed,(before+typed).length,"insertText",typed,true,false)).toBe(expected);
 expect(quote("ab",'a"b',2,"insertText",'"',true,false)).toBe('a”b');
});
it("paste, composition, disabled preferences and malformed events preserve text",()=>{
 for(const [type,enabled,composing] of [["insertFromPaste",true,false],["insertCompositionText",true,true],["insertText",false,false],["insertText",true,true],["insertReplacementText",true,false]] as const)expect(quote("",'"',1,type,'"',enabled,composing)).toBe('"');
 expect(quote("ab",'x"b',2,"insertText",'"',true,false)).toBe('x"b');
 expect(quote("",'"',0,"insertText",'"',true,false)).toBe('"');
});
