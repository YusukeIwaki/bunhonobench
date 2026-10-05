# frozen_string_literal: true

# Single process (like Bun's single process) with a thread pool.
max_threads = ENV.fetch('PUMA_MAX_THREADS', '16').to_i
min_threads = ENV.fetch('PUMA_MIN_THREADS', '4').to_i
threads min_threads, max_threads
workers 0

port ENV.fetch('PORT', '4567')
environment ENV.fetch('RACK_ENV', 'production')

# Quiet: no request logging during benchmarks
quiet
