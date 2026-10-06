import { HttpClient } from '@angular/common/http';
import { TranslateLoader, type TranslationObject } from '@ngx-translate/core';
import { Observable, forkJoin, map, of } from 'rxjs';
import { catchError } from 'rxjs/operators';

/**
 * Loads and merges several JSON bundles per language so feature areas can own
 * their own files: /i18n/<lang>.json (clinic app) + /i18n/portal.<lang>.json (patient portal).
 */
export class MultiFileTranslateLoader implements TranslateLoader {
  constructor(
    private readonly http: HttpClient,
    private readonly prefixes: readonly string[] = ['', 'portal.'],
  ) {}

  getTranslation(lang: string): Observable<TranslationObject> {
    const requests = this.prefixes.map((prefix) =>
      this.http.get<TranslationObject>(`/i18n/${prefix}${lang}.json`).pipe(catchError(() => of({} as TranslationObject))),
    );
    return forkJoin(requests).pipe(map((bundles) => Object.assign({}, ...bundles) as TranslationObject));
  }
}
