import 'package:flutter_test/flutter_test.dart';
import 'package:rowskan/store.dart';
void main(){
 test('VIN rejects forbidden characters and partial scans',(){
  expect(validVin('1HGCM82633A004352'),isTrue);
  expect(validVin('1HGCM82633A00435I'),isFalse);
  expect(validVin('1HGCM82633A00435'),isFalse);
 });
 test('team phone cannot delete while solo owner can',(){
  expect(canDelete('team',desktop:false),isFalse);
  expect(canDelete('team',desktop:true),isTrue);
  expect(canDelete('solo',desktop:false),isTrue);
 });
}
