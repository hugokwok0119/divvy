import unittest
import agy_runner

class AntigravityEnvelopeTests(unittest.TestCase):
    def test_extracts_structured_output(self):
        value = {'transactions': [], 'reconciliationComponents': None}
        self.assertEqual(agy_runner.extract_output({'status':'SUCCESS', 'structured_output':value}),value)

    def test_rejects_success_without_extraction(self):
        with self.assertRaises(ValueError):
            agy_runner.extract_output({'status':'SUCCESS', 'response':'', 'denied_actions':[{'action':'command'}]})

    def test_rejects_unsuccessful_envelope(self):
        with self.assertRaises(ValueError):
            agy_runner.extract_output({'status':'ERROR', 'structured_output':{}})

if __name__ == '__main__':
    unittest.main()
