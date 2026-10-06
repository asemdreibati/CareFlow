import { Module } from '@nestjs/common';
import { RecordsSearchController, SearchController } from './search.controller.js';
import { SearchService } from './search.service.js';

/** Arabic/Latin-aware search: global search, records full-text search and ICD autocomplete. */
@Module({
  controllers: [SearchController, RecordsSearchController],
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchModule {}
