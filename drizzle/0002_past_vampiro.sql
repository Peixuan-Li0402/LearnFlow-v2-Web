CREATE TABLE `course_materials` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` text NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`object_key` text NOT NULL,
	`status` text NOT NULL,
	`parse_progress` integer DEFAULT 0 NOT NULL,
	`extracted_text` text,
	`page_count` integer,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `course_materials_course_idx` ON `course_materials` (`course_id`);--> statement-breakpoint
CREATE TABLE `courses` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`outline_json` text,
	`outline_confirmed` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `explanation_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` text NOT NULL,
	`node_id` text NOT NULL,
	`title` text NOT NULL,
	`sections_json` text NOT NULL,
	`source_refs_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `explanation_artifacts_node_idx` ON `explanation_artifacts` (`node_id`);--> statement-breakpoint
CREATE TABLE `graph_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` text NOT NULL,
	`status` text NOT NULL,
	`stage` text NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`error` text,
	`trace_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `graph_jobs_course_idx` ON `graph_jobs` (`course_id`);--> statement-breakpoint
CREATE TABLE `knowledge_edges` (
	`id` text PRIMARY KEY NOT NULL,
	`graph_id` text NOT NULL,
	`course_id` text NOT NULL,
	`source_node_id` text NOT NULL,
	`target_node_id` text NOT NULL,
	`type` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`confidence` real DEFAULT 1 NOT NULL,
	`inferred` integer DEFAULT false NOT NULL,
	`source_refs_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `knowledge_edges_course_idx` ON `knowledge_edges` (`course_id`);--> statement-breakpoint
CREATE INDEX `knowledge_edges_graph_idx` ON `knowledge_edges` (`graph_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_edges_unique_idx` ON `knowledge_edges` (`graph_id`,`source_node_id`,`target_node_id`,`type`);--> statement-breakpoint
CREATE TABLE `knowledge_graphs` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` text NOT NULL,
	`title` text NOT NULL,
	`version` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `knowledge_graphs_course_idx` ON `knowledge_graphs` (`course_id`);--> statement-breakpoint
CREATE TABLE `knowledge_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`graph_id` text NOT NULL,
	`course_id` text NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`short_summary` text NOT NULL,
	`importance` text NOT NULL,
	`difficulty` text NOT NULL,
	`exam_weight` real DEFAULT 0 NOT NULL,
	`confidence` real DEFAULT 1 NOT NULL,
	`source_refs_json` text NOT NULL,
	`explanation_artifact_id` text,
	`learning_status` text DEFAULT 'UNSEEN' NOT NULL,
	`generated_from` text NOT NULL,
	`chapter_id` text,
	`formula` text,
	`conditions_json` text DEFAULT '[]' NOT NULL,
	`aliases_json` text DEFAULT '[]' NOT NULL,
	`order_index` integer DEFAULT 0 NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `knowledge_nodes_course_idx` ON `knowledge_nodes` (`course_id`);--> statement-breakpoint
CREATE INDEX `knowledge_nodes_graph_idx` ON `knowledge_nodes` (`graph_id`);--> statement-breakpoint
CREATE INDEX `knowledge_nodes_title_idx` ON `knowledge_nodes` (`title`);--> statement-breakpoint
CREATE TABLE `learning_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` text NOT NULL,
	`node_id` text,
	`kind` text NOT NULL,
	`messages_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `learning_sessions_course_idx` ON `learning_sessions` (`course_id`);--> statement-breakpoint
CREATE TABLE `material_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` text NOT NULL,
	`material_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`heading` text DEFAULT '' NOT NULL,
	`text` text NOT NULL,
	`page` integer,
	`slide` integer,
	`source_ref_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `material_chunks_course_idx` ON `material_chunks` (`course_id`);--> statement-breakpoint
CREATE INDEX `material_chunks_material_idx` ON `material_chunks` (`material_id`);--> statement-breakpoint
CREATE TABLE `node_learning_states` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` text NOT NULL,
	`node_id` text NOT NULL,
	`status` text NOT NULL,
	`confidence` real DEFAULT 0.5 NOT NULL,
	`evidence_json` text DEFAULT '[]' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `node_learning_states_unique_idx` ON `node_learning_states` (`course_id`,`node_id`);--> statement-breakpoint
CREATE TABLE `problem_knowledge_links` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` text NOT NULL,
	`project_id` text NOT NULL,
	`problem_id` text NOT NULL,
	`node_id` text NOT NULL,
	`relevance` real NOT NULL,
	`evidence` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `problem_knowledge_links_problem_idx` ON `problem_knowledge_links` (`project_id`,`problem_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `problem_knowledge_links_unique_idx` ON `problem_knowledge_links` (`project_id`,`problem_id`,`node_id`);--> statement-breakpoint
CREATE TABLE `review_route_items` (
	`id` text PRIMARY KEY NOT NULL,
	`route_id` text NOT NULL,
	`day_index` integer NOT NULL,
	`date` text NOT NULL,
	`title` text NOT NULL,
	`node_ids_json` text NOT NULL,
	`estimated_minutes` integer NOT NULL,
	`rationale` text NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `review_route_items_route_idx` ON `review_route_items` (`route_id`);--> statement-breakpoint
CREATE TABLE `review_routes` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` text NOT NULL,
	`exam_date` text NOT NULL,
	`daily_minutes` integer NOT NULL,
	`scope` text NOT NULL,
	`target_score` integer,
	`summary` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `review_routes_course_idx` ON `review_routes` (`course_id`);--> statement-breakpoint
ALTER TABLE `projects` ADD `course_id` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `project_type` text DEFAULT 'ASSIGNMENT' NOT NULL;