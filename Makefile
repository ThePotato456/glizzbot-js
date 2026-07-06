NODE ?= node
NPM ?= npm
TSC := $(NODE) ./node_modules/typescript/bin/tsc

.PHONY: help install dev build run test test-watch typecheck clean reset-config docker-build docker-run

help:
	@echo Available targets:
	@echo   make install       Install project dependencies
	@echo   make dev           Run the bot in watch mode
	@echo   make build         Compile TypeScript into dist/
	@echo   make run           Run the compiled bot
	@echo   make test          Run the automated test suite
	@echo   make test-watch    Run tests in watch mode
	@echo   make typecheck     Run the TypeScript compiler without emitting files
	@echo   make docker-build  Build the container image
	@echo   make docker-run    Run the container with the local config directory mounted
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

docker-build:
	docker build -t glizzbot-js .

docker-run:
	docker run --rm -p 3000:3000 -v $(CURDIR)/config:/app/config glizzbot-js

clean:
	@if exist dist rmdir /s /q dist

reset-config:
	@if not exist config\config.json copy config\config.example.json config\config.json >nul
