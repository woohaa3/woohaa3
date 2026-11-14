/** Actor and movement choices are explicit; kinematic alignment is owned by the host. */
export type HumanoidInteractionActor = {
  instanceId:string; expectedVersion:string; prompt:string; duration:number;
  rootMotion:'in-place'|'translate';
  /** Only for a user explicitly requesting stationary playback despite source root travel. */
  allowInPlaceTravel?:boolean;
};
export type HumanoidInteractionInput = {
  canvasId:string; contextId:string; requestId:string;
  initiator:HumanoidInteractionActor; responder:HumanoidInteractionActor;
  initiatorEvent:'leftHandForward'|'rightHandForward'|'handsForward'|'leftFootForward'|'rightFootForward';
};
