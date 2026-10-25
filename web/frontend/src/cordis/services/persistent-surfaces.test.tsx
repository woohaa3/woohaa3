// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createPersistentSurfaces } from "./persistent-surfaces.js";
it("keeps an owner DOM stable and ignores an old binding disposer",()=>{
  const registry=createPersistentSurfaces(), dispose=vi.fn(), factory=vi.fn(()=>({dispose}));
  const owner=registry.acquire("editor",factory), original=owner.element;
  const target=document.createElement("div");document.body.append(target);
  const old=owner.bind(target), current=owner.bind(target);old();
  expect(owner.element.style.display).toBe("block");current();expect(owner.element.style.display).toBe("none");
  expect(registry.acquire("editor",factory)).toBe(owner);expect(owner.element).toBe(original);expect(factory).toHaveBeenCalledOnce();
  registry.dispose();registry.dispose();expect(dispose).toHaveBeenCalledOnce();expect(original.isConnected).toBe(false);target.remove();
});
it("revokes regular acquisition while retaining one recoverable owner",()=>{
  const registry=createPersistentSurfaces(), revoke=vi.fn(()=>true), dispose=vi.fn();
  const owner=registry.acquire("editor",()=>({revoke,dispose}));registry.setEnabled("editor",false);
  expect(revoke).toHaveBeenCalledWith("disabled");expect(dispose).not.toHaveBeenCalled();expect(owner.element.isConnected).toBe(true);
  expect(()=>registry.acquire("editor",()=>({dispose}))).toThrow("不可用");
  registry.setEnabled("editor",true);expect(registry.acquire("editor",()=>({dispose}))).toBe(owner);
  registry.revokeIdentity();expect(revoke).toHaveBeenLastCalledWith("identity");expect(()=>registry.acquire("editor",()=>({dispose}))).toThrow();
  owner.release();expect(dispose).toHaveBeenCalledOnce();registry.dispose();
});
it("releases owners without recoverable local work immediately",()=>{
  const registry=createPersistentSurfaces(), dispose=vi.fn();const owner=registry.acquire("empty",()=>({dispose,revoke:()=>false}));
  registry.setEnabled("empty",false);expect(dispose).toHaveBeenCalledOnce();expect(owner.element.isConnected).toBe(false);registry.dispose();
});
