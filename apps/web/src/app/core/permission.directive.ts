import { Directive, TemplateRef, ViewContainerRef, effect, inject, input } from '@angular/core';
import { AuthService } from './auth.service';

/**
 * Structural directive: `<button *hasPermission="'patients:write'">` or
 * `*hasPermission="['billing:read', 'billing:write']"` (all required).
 * Use `*hasPermission="'a'; any: true"` to require any of a list.
 */
@Directive({ selector: '[hasPermission]' })
export class HasPermissionDirective {
  private readonly tpl = inject(TemplateRef<unknown>);
  private readonly vcr = inject(ViewContainerRef);
  private readonly auth = inject(AuthService);
  private rendered = false;

  readonly hasPermission = input.required<string | string[]>();
  readonly hasPermissionAny = input(false);

  constructor() {
    effect(() => {
      const raw = this.hasPermission();
      const perms = Array.isArray(raw) ? raw : [raw];
      const ok = this.hasPermissionAny() ? this.auth.hasAny(...perms) : this.auth.hasPermission(...perms);
      if (ok && !this.rendered) {
        this.vcr.createEmbeddedView(this.tpl);
        this.rendered = true;
      } else if (!ok && this.rendered) {
        this.vcr.clear();
        this.rendered = false;
      }
    });
  }
}
