NODE ?= node
NPM ?= npm.cmd
TSC := $(NODE) ./node_modules/typescript/bin/tsc

.PHONY: help install dev build run test test-watch typecheck clean reset-config

help:
	@echo Available targets:
	@echo   make install       Install project dependencies
	@echo   make dev           Run the bot in watch mode
	@echo   make build         Compile TypeScript into dist/
	@echo   make run           Run the compiled bot
	@echo   make test          Run the automated test suite
	@echo   make test-watch    Run tests in watch mode
	@echo   make typecheck     Run the TypeScript compiler without emitting files
	@echo   make clean         Remove build output
	@echo   make reset-config  Copy example config if config/config.json is missing

install:
	$(NPM) install

dev:
	$(NPM) run dev

build:
	$(NPM) run build

run:
	$(NPM) run start

test:
	$(NPM) run test

test-watch:
	$(NPM) run test:watch

typecheck:
	$(TSC) -p tsconfig.json --noEmit

clean:
	@if exist dist rmdir /s /q dist

reset-config:
	@if not exist config\config.json copy config\config.example.json config\config.json >nul
