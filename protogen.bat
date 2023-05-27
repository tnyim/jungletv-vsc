protoc ^
  --plugin=protoc-gen-ts=.\node_modules\.bin\protoc-gen-ts.cmd ^
  --plugin=protoc-gen-js=.\node_modules\.bin\protoc-gen-js.cmd ^
  -I .\src\proto ^
  --js_out=import_style=commonjs,binary:.\src\proto ^
  --ts_out=service=grpc-web:.\src\proto ^
  .\src\proto\*.proto