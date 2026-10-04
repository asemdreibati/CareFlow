import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ToastContainerComponent } from './shared/toast-container';
import { ConfirmHostComponent } from './shared/confirm-dialog';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, ToastContainerComponent, ConfirmHostComponent],
  template: `<router-outlet /><cf-toasts /><cf-confirm-host />`,
})
export class App {}
