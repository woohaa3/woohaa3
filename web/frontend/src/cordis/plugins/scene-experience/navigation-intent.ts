/** Same semantics as controller pan transitions: only the latest local intent may commit. */
export class SceneNavigationIntent {
  private generation=0;
  begin(){return ++this.generation;}
  current(generation:number){return generation===this.generation;}
  cancel(){this.generation++;}
}
