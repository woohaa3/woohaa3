/** 按住工具键临时切换；恢复等待当前画布手势结算。 */
export class SpringTools<T> {
 private held:{key:string;from:T;to:T;at:number;used:boolean;released:boolean}|null=null;
 get pending():boolean {return this.held!==null;}
 persistentTool(current:T):T {return this.held?.from??current;}
 press(key:string,from:T,to:T,at:number):void {
  if(this.held?.key===key || from===to)return;
  this.held={key,from,to,at,used:false,released:false};
 }
 useCanvas():void {if(this.held && !this.held.released)this.held.used=true;}
 release(key:string,at:number,busy:boolean):T|null {
  const held=this.held;if(!held || held.key!==key)return null;
  if(!held.used && at-held.at<300){this.held=null;return null;}
  held.released=true;return this.finish(busy);
 }
 finish(busy:boolean):T|null {
  if(busy || !this.held?.released)return null;
  const previous=this.held.from;this.held=null;return previous;
 }
 reset():T|null {const previous=this.held?.from??null;this.held=null;return previous;}
}
